/* The system unix VFS keeps responsibility for pager I/O, its selected locks, WAL
 * shared memory and DMS. Its documented syscall hooks only substitute the
 * descriptors already authorized by FileReader. This helper is one-shot and
 * single-connection; hooks are never installed in the parent/app process. */
#include <sqlite3.h>
#include <sys/stat.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <fcntl.h>
#include <unistd.h>
#include <poll.h>
#include <errno.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <limits.h>

static char names[4][PATH_MAX];
static int descriptors[4];
static sqlite3_vfs descriptorVFS, *unixVFS;
static sqlite3_io_methods mainMethods;
static const sqlite3_io_methods *unixMainMethods;
static int acknowledged;
static const char *failureDetail;
/* Pure policy predicate, also exercised without mounting or touching volumes.
 * This is the normal kernel local read-only mount guarantee, not a claim of
 * immutability against privileged remounts or writes to the underlying device. */
int ch_sqlite_local_readonly_mounts(int count,const struct statfs *mounts){
  if(count<1 || count>4 || !mounts)return 0;
  for(int i=0;i<count;i++){
    if((mounts[i].f_flags&(MNT_LOCAL|MNT_RDONLY))!=(MNT_LOCAL|MNT_RDONLY)
       || memcmp(&mounts[0].f_fsid,&mounts[i].f_fsid,sizeof(mounts[i].f_fsid))!=0)return 0;
  }
  return 1;
}
static int inheritedLocalReadonlyMounts(void){
  struct statfs mounts[4];int count=0;
  for(int i=0;i<4;i++)if(descriptors[i]>=0){
    if(fstatfs(descriptors[i],&mounts[count])!=0)return 0;
    count++;
  }
  return ch_sqlite_local_readonly_mounts(count,mounts);
}
static int indexOf(const char *name){
  if(name) for(int i=0;i<4;i++) if(strcmp(name,names[i])==0) return i;
  return -1;
}
static int descriptorOpen(const char *name,int flags,int mode){
  int i=indexOf(name);
  if(i<0){errno=EACCES;return -1;}
  if(descriptors[i]<0){errno=ENOENT;return -1;}
  /* In particular, let unixOpenSharedMemory retry its O_RDWR request as
   * O_RDONLY. Never misreport an O_RDONLY SHM descriptor as writable. */
  if((i>0 && !acknowledged) || (flags&O_ACCMODE)!=O_RDONLY || (flags&(O_CREAT|O_TRUNC|O_EXCL))){errno=EACCES;return -1;}
  return fcntl(descriptors[i],F_DUPFD_CLOEXEC,8);
}
static int descriptorStat(const char *name,struct stat *out){
  int i=indexOf(name);if(i<0){errno=EACCES;return -1;}
  if(descriptors[i]<0){errno=ENOENT;return -1;}
  return fstat(descriptors[i],out);
}
static int descriptorAccess(const char *name,int mode){
  int i=indexOf(name);if(i<0){errno=EACCES;return -1;}
  if(descriptors[i]<0){errno=ENOENT;return -1;}
  if(mode&W_OK){errno=EACCES;return -1;}return 0;
}
static ssize_t noReadlink(const char *name,char *out,size_t count){errno=EINVAL;return -1;}
static ssize_t descriptorRead(int fd,void *data,size_t count){
  if(!acknowledged){errno=EACCES;return -1;}return read(fd,data,count);
}
static ssize_t descriptorPread(int fd,void *data,size_t count,off_t offset){
  if(!acknowledged){errno=EACCES;return -1;}return pread(fd,data,count,offset);
}
static void *descriptorMmap(void *address,size_t length,int protection,int flags,int fd,off_t offset){
  if(!acknowledged || (protection&PROT_WRITE)){errno=EACCES;return MAP_FAILED;}
  return mmap(address,length,protection,flags,fd,offset);
}
static int noUnlink(const char *name){errno=EACCES;return -1;}
static int noTruncate(int fd,off_t length){errno=EACCES;return -1;}
static ssize_t noWrite(int fd,const void *data,size_t count){errno=EACCES;return -1;}
static ssize_t noPwrite(int fd,const void *data,size_t count,off_t offset){errno=EACCES;return -1;}
static int noMkdir(const char *name,mode_t mode){errno=EACCES;return -1;}
static int noOpenDirectory(const char *name,int *fd){*fd=-1;return SQLITE_CANTOPEN;}
static int noChmod(int fd,mode_t mode){errno=EACCES;return -1;}
static int noChown(int fd,uid_t uid,gid_t gid){errno=EACCES;return -1;}
static int descriptorFullPath(sqlite3_vfs *v,const char *name,int count,char *out){
  if(indexOf(name)!=0 || strlen(name)>=(size_t)count)return SQLITE_CANTOPEN;
  memcpy(out,name,strlen(name)+1);return SQLITE_OK;
}
static int descriptorExists(sqlite3_vfs *v,const char *name,int flags,int *out){
  int i=indexOf(name);*out=0;if(i<0)return SQLITE_IOERR_ACCESS;
  *out=(descriptors[i]>=0 && flags!=SQLITE_ACCESS_READWRITE);return SQLITE_OK;
}
static int noDelete(sqlite3_vfs *v,const char *name,int sync){return SQLITE_READONLY;}
static int retainShared(sqlite3_file *file,int level){
  return unixMainMethods->xUnlock(file,level<SQLITE_LOCK_SHARED?SQLITE_LOCK_SHARED:level);
}
static int descriptorXOpen(sqlite3_vfs *v,sqlite3_filename name,sqlite3_file *file,int flags,int *out){
  int i=indexOf(name);
  if(i<0 || descriptors[i]<0 || (i==0 && !(flags&SQLITE_OPEN_READONLY))){
    file->pMethods=0;return SQLITE_CANTOPEN;
  }
  int rc=unixVFS->xOpen(unixVFS,name,file,flags,out);
  if(rc==SQLITE_OK && (flags&SQLITE_OPEN_MAIN_DB)){
    const sqlite3_io_methods *methods=file->pMethods;
    rc=methods->xLock(file,SQLITE_LOCK_SHARED);
    int state=SQLITE_LOCK_NONE;
    if(rc==SQLITE_OK){
      rc=methods->xFileControl(file,SQLITE_FCNTL_LOCKSTATE,&state);
      if(rc!=SQLITE_OK || state<SQLITE_LOCK_SHARED){
        if(inheritedLocalReadonlyMounts())rc=SQLITE_OK;
        else{
          struct statfs fs;
          failureDetail=fstatfs(3,&fs)==0 && (fs.f_flags&MNT_RDONLY)
            ?"SQLITE_READONLY_MOUNT_LOCK_UNAVAILABLE":"SQLITE_LOCK_COORDINATION_UNAVAILABLE";
          rc=SQLITE_IOERR_LOCK;
        }
      }
    }
    if(rc==SQLITE_OK){
      if(write(7,"ready\n",6)!=6)rc=SQLITE_IOERR;
      else{
        struct pollfd ack={.fd=0,.events=POLLIN};char value=0;
        if(poll(&ack,1,5000)!=1 || read(0,&value,1)!=1 || value!='1')rc=SQLITE_ABORT;
      }
    }
    if(rc!=SQLITE_OK){
      methods->xClose(file);file->pMethods=0;return rc;
    }
    acknowledged=1;
    unixMainMethods=methods;mainMethods=*methods;
    mainMethods.xUnlock=retainShared;file->pMethods=&mainMethods;
  }
  return rc;
}
/* Install the descriptor-only VFS before sqlite3_open_v2. Its main xOpen obtains
 * the actual system-selected lock, then awaits parent revalidation before it
 * returns control to the SQLite pager. fd7 carries readiness; stdin the ACK. */
int ch_sqlite_descriptors(const char *path,int mask){
  if(!(mask&1) || (mask&~15))return SQLITE_MISUSE;
  const char *suffixes[]={"","-wal","-shm","-journal"};
  for(int i=0;i<4;i++){
    if(snprintf(names[i],sizeof(names[i]),"%s%s",path,suffixes[i])>=(int)sizeof(names[i]))return SQLITE_CANTOPEN;
    descriptors[i]=(mask&(1<<i))?3+i:-1;
    if(descriptors[i]>=0){
      struct stat st;int mode=fcntl(descriptors[i],F_GETFL);
      if(mode<0 || (mode&O_ACCMODE)!=O_RDONLY || fstat(descriptors[i],&st)||!S_ISREG(st.st_mode)||st.st_nlink!=1)return SQLITE_CANTOPEN;
    }
  }
  unixVFS=sqlite3_vfs_find("unix");
  if(!unixVFS || unixVFS->iVersion<3 || !unixVFS->xSetSystemCall || !unixVFS->xGetSystemCall)return SQLITE_NOTFOUND;
  struct {const char *name;sqlite3_syscall_ptr fn;} hooks[]={
    {"open",(sqlite3_syscall_ptr)descriptorOpen},{"stat",(sqlite3_syscall_ptr)descriptorStat},
    {"lstat",(sqlite3_syscall_ptr)descriptorStat},{"access",(sqlite3_syscall_ptr)descriptorAccess},
    {"readlink",(sqlite3_syscall_ptr)noReadlink},{"unlink",(sqlite3_syscall_ptr)noUnlink},
    {"read",(sqlite3_syscall_ptr)descriptorRead},{"pread",(sqlite3_syscall_ptr)descriptorPread},
    {"mmap",(sqlite3_syscall_ptr)descriptorMmap},
    {"fchmod",(sqlite3_syscall_ptr)noChmod},{"fchown",(sqlite3_syscall_ptr)noChown},
    {"ftruncate",(sqlite3_syscall_ptr)noTruncate},{"write",(sqlite3_syscall_ptr)noWrite},
    {"pwrite",(sqlite3_syscall_ptr)noPwrite},{"mkdir",(sqlite3_syscall_ptr)noMkdir},
    {"rmdir",(sqlite3_syscall_ptr)noUnlink},{"openDirectory",(sqlite3_syscall_ptr)noOpenDirectory}
  };
  for(size_t i=0;i<sizeof(hooks)/sizeof(hooks[0]);i++){
    if(!unixVFS->xGetSystemCall(unixVFS,hooks[i].name) || unixVFS->xSetSystemCall(unixVFS,hooks[i].name,hooks[i].fn)!=SQLITE_OK)return SQLITE_NOTFOUND;
  }
  descriptorVFS=*unixVFS;descriptorVFS.zName="chathand-descriptors";descriptorVFS.pNext=0;
  descriptorVFS.xOpen=descriptorXOpen;descriptorVFS.xFullPathname=descriptorFullPath;
  descriptorVFS.xAccess=descriptorExists;descriptorVFS.xDelete=noDelete;
  return sqlite3_vfs_register(&descriptorVFS,0);
}

int ch_sqlite_disable_extensions(sqlite3 *db){
  return sqlite3_db_config(db,SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION,0,0);
}
const char *ch_sqlite_descriptor_error(void){return failureDetail;}
