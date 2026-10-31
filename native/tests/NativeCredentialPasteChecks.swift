import Foundation
@main struct NativeCredentialPasteChecks {
 static func check(_ value:@autoclosure ()->Bool,_ label:String){if !value(){fatalError(label)}}
 static func main() throws {
  let key="sk-"+String(repeating:"a",count:24),tunnel="tunnel_fixture123",siteOrigin="https://fixture.chatgpt.site"
  var rows:[[String:Any]]=[]
  func runtime(_ authorized:Bool=true,_ value:String?,_ response:[String:Any],changed:Bool=false,countChanged:Bool=false)->[String:Any]{
   var clipboard=value,count=1,reads=0,clears=0,submits=0;var result:[String:Any]=[:]
   NativeCredentialPaste.runtime(tunnelID:tunnel,authorized:authorized,changeCount:{count},read:{reads+=1;return clipboard},clear:{clears+=1;clipboard=nil;count+=1},submit:{body,done in
    submits+=1;check(body["api_key"] as? String==key,"only fake key submitted privately");if changed{clipboard="new unrelated fake clipboard";count+=1};if countChanged{count+=1};done(response)
   },completion:{result=$0})
   if !authorized{check(reads==0 && submits==0 && clears==0,"unauthorized window never reads clipboard")}
   result["test_clears"]=clears;result["test_submits"]=submits;return result
  }
  let success:[String:Any]=["saved":true,"received":true,"storage_verified":true,"configured":false,"connected":false,"last4":"must not return","api_key":key]
  let denied=runtime(false,key,success);check(denied["reason_code"] as? String=="NATIVE_OWNER_AUTH_REQUIRED","owner auth retained")
  for value in [nil,"ordinary copied text",String(repeating:"x",count:10000)] as [String?]{let invalid=runtime(true,value,success);check(invalid["reason_code"] as? String=="CLIPBOARD_NOT_A_KEY","clear invalid clipboard reason");check(invalid["error_code"] as? String=="CLIPBOARD_KEY_INVALID","existing UI invalid message mapping");check(invalid["test_submits"] as? Int==0,"invalid input not submitted");rows.append(["case":"invalid-runtime","response":invalid])}
  let received=runtime(true,key,success);check(received["saved"] as? Bool==true && received["received"] as? Bool==true && received["connected"] as? Bool==false,"receipt independent of connection pending");check(received["test_clears"] as? Int==1,"verified same clipboard cleared");check(received["last4"]==nil && received["api_key"]==nil,"no tail or secret projection")
  for response:[String:Any] in [["saved":true],["saved":true,"received":true],["saved":NSNumber(value:1),"received":true,"storage_verified":true],["saved":false,"error":["code":key]],["saved":false,"error":["code":"CREDENTIAL_WRITE_VERIFY_FAILED"]]]{let failed=runtime(true,key,response);check(failed["saved"] as? Bool==false && failed["test_clears"] as? Int==0,"failed/unverified/malformed receipt retains key")}
  let busy=runtime(true,key,["saved":false,"error":["code":"CREDENTIAL_BUSY"]]);check(busy["error_code"] as? String=="CREDENTIAL_BUSY" && busy["reason_code"] as? String=="CREDENTIAL_BUSY","fixed backend busy code preserved")
  check(runtime(true,key,success,changed:true)["clipboard_cleared"] as? Bool==false,"later clipboard preserved");check(runtime(true,key,success,countChanged:true)["clipboard_cleared"] as? Bool==false,"same text recopy preserved")
  func site(_ authorized:Bool=true,_ input:String,_ response:[String:Any],changed:Bool=false)->[String:Any]{
   var clipboard=input,count=1,reads=0,clears=0,submits=0;var result:[String:Any]=[:]
   NativeCredentialPaste.site(authorized:authorized,changeCount:{count},read:{reads+=1;return clipboard},clear:{clears+=1;clipboard="";count+=1},submit:{_,done in submits+=1;if changed{clipboard="later unrelated fake content";count+=1};done(response)},completion:{result=$0})
   if !authorized{check(reads==0 && submits==0,"unauthorized site never reads clipboard")};result["test_clears"]=clears;return result
  }
  let body:[String:Any]=["format":"chathand-site-v2","site_id":"fixture-site","site_origin":siteOrigin,"service_credential":String(repeating:"b",count:40)]
  let copied=String(data:try JSONSerialization.data(withJSONObject:body),encoding:.utf8)!
  for phase in ["pairing","credential_updated"]{let response=site(true,copied,["accepted":true,"phase":phase,"origin":siteOrigin,"echo":copied]);check(response["accepted"] as? Bool==true && response["received"] as? Bool==true,"Site receipt accepted without human input");check(response["phase"] as? String==phase && response["origin"] as? String==siteOrigin,"pairing phase and validated origin preserved");check(response["test_clears"] as? Int==1 && response["echo"]==nil,"secret not projected");rows.append(["case":"site-"+phase,"response":response])}
  for response:[String:Any] in [["accepted":false,"error":["code":"B_GRANT_EXPIRED"]],["accepted":true,"phase":"unexpected","origin":siteOrigin],["accepted":true,"phase":"pairing","origin":"https://foreign.chatgpt.site"],["accepted":true,"phase":42,"origin":siteOrigin],["accepted":true,"phase":"pairing","origin":"https://fixture.chatgpt.site/?secret=fake"]]{let failed=site(true,copied,response);check(failed["accepted"] as? Bool==false && failed["test_clears"] as? Int==0,"unverified Site receipt retains clipboard and cannot trigger legacy pair")}
  let legacy=String(data:try JSONSerialization.data(withJSONObject:["site_id":"fixture-site","site_origin":siteOrigin,"enrollment_grant":"fake grant only"]),encoding:.utf8)!
  let wrongLegacy=site(true,legacy,["accepted":true,"phase":"pairing","origin":siteOrigin]);check(wrongLegacy["accepted"] as? Bool==false,"legacy input cannot claim v2 phase")
  let legacyReceipt=site(true,legacy,["accepted":true,"phase":"awaiting_pairing"]);check(legacyReceipt["phase"] as? String=="awaiting_pairing","legacy pairing contract retained");check(legacyReceipt["origin"] as? String==siteOrigin,"legacy validated source used")
  let customOrigin="https://fixture.example:8443"
  let customLegacy=String(data:try JSONSerialization.data(withJSONObject:["site_id":"fixture-site","site_origin":customOrigin,"enrollment_grant":"fake grant only"]),encoding:.utf8)!
  let custom=site(true,customLegacy,["accepted":true,"phase":"awaiting_pairing"]);check(custom["accepted"] as? Bool==true && custom["origin"] as? String==customOrigin,"legacy canonical HTTPS port contract retained")
  check(site(true,copied,["accepted":true,"phase":"pairing","origin":siteOrigin],changed:true)["clipboard_cleared"] as? Bool==false,"Site later clipboard preserved")
  let invalidSite=site(true,"ordinary copied text",[:]);check(invalidSite["reason_code"] as? String=="CLIPBOARD_NOT_A_KEY","Site invalid clipboard reason");_ = site(false,copied,[:]);rows.append(["case":"invalid-site","response":invalidSite]);rows.append(["case":"runtime-connection-pending","response":received])
  let bytes=try JSONSerialization.data(withJSONObject:rows,options:[.prettyPrinted,.sortedKeys]);let output=String(data:bytes,encoding:.utf8)!;check(!output.contains(key) && !output.contains(copied),"no credential in result/diagnostics");print(output);print("PASS: manual authenticated receipt, no physical gesture, exact clipboard cleanup and secret-free projection")
 }
}
