import Foundation

// Every process, timer, signal, pipe and runtime descriptor is synthetic.
// The tested App methods below are extracted unchanged from native/main.swift.
let SIGTERM: Int32 = 15, SIGKILL: Int32 = 9, ESRCH: Int32 = 3
var errno: Int32 = 0
struct Deadline {
    let time: TimeInterval
    static func now() -> Deadline { Deadline(time: Clock.now) }
    static func +(lhs: Deadline, rhs: TimeInterval) -> Deadline { Deadline(time: lhs.time + rhs) }
}
enum Clock { static var now: TimeInterval = 0 }
enum Scheduler {
    struct Job {let at: TimeInterval;let order: Int;let work: () -> Void}
    static var jobs: [Job] = [], sequence = 0
    static func after(deadline: Deadline, execute: @escaping () -> Void) { sequence += 1;jobs.append(Job(at: deadline.time,order: sequence,work: execute)) }
    static func advance(_ seconds: TimeInterval) {
        let end = Clock.now + seconds
        var count = 0
        while let next = jobs.filter({$0.at <= end}).min(by: {$0.at == $1.at ? $0.order < $1.order : $0.at < $1.at}) {
            jobs.removeAll {$0.order == next.order};Clock.now = next.at;next.work();count += 1
            precondition(count < 10000, "timer loop must be bounded")
        }
        Clock.now = end
    }
    static func reset() { jobs=[];sequence=0;Clock.now=0;InstanceLifecycle.identities=[:];Darwin.signals=[];Darwin.signalAllowed=true }
}
final class Timer {
    let interval: TimeInterval, repeats: Bool, block: (Timer) -> Void
    private(set) var valid = true
    init(_ interval: TimeInterval,_ repeats: Bool,_ block: @escaping (Timer) -> Void) {self.interval=interval;self.repeats=repeats;self.block=block}
    static func scheduledTimer(withTimeInterval interval: TimeInterval,repeats: Bool,block: @escaping (Timer) -> Void) -> Timer {
        let timer=Timer(interval,repeats,block);timer.schedule();return timer
    }
    func schedule() {Scheduler.after(deadline:.now()+interval) {if self.valid{self.block(self);if self.repeats && self.valid{self.schedule()}}}}
    func invalidate() {valid=false}
    // Timer invalidation need not retract an already-queued callback.
    func deliverQueued() {block(self)}
}
final class Process {
    let processIdentifier: Int32
    var isRunning=true
    var exitOnSignal=true
    init(_ pid: Int32) {processIdentifier=pid}
    func terminate() {_=Darwin.kill(processIdentifier,SIGTERM)}
}
enum InstanceLifecycle {
    struct Identity: Equatable {let pid: Int32;let stamp: Int}
    static var identities: [Int32:Identity] = [:]
    static func identity(_ pid: Int32) throws -> Identity? {identities[pid]}
}
enum Darwin {
    static var signals: [(Int32,Int32)] = []
    static var signalAllowed=true
    static var processes: [Int32:Process] = [:]
    static func kill(_ pid: Int32,_ signal: Int32) -> Int32 {
        guard signalAllowed else{return -1}
        signals.append((pid,signal))
        if let p=processes[pid],p.exitOnSignal{p.isRunning=false;InstanceLifecycle.identities[pid]=nil}
        return 0
    }
}
enum LocalText {static func text(_ key: String) -> String {key}}
enum ComputerControl {static var stopped=false}
final class Cancelable {func cancel() {}}
final class KeepAwake {func update(_ value: Bool) {}}

final class App {
    var process: Process?,attachedBackend: Process?,stoppingStartupBackend: Process?
    var backendGeneration=UUID(),backendRecovery=BackendRecoveryPolicy(),backendRecoveryInProgress=false
    var ownsService=false,shuttingDown=false,uninstallInProgress=false,installer=false,interfaceKeyShared=true
    var timer: Timer?,onboardingSending=false,onboardingRetryAfter: TimeInterval=0
    var chromeInstallContinuation: (() -> Void)?,chromeInstallPreparation: UUID?
    let chromeProfileDiscovery=Cancelable(),chromeHelperInstaller=Cancelable(),keepAwake=KeepAwake()
    var pollInFlight=false,computerPollInFlight=false,computerActionInFlight=false,clientUIReady=false,serviceAvailable=false
    var starts=0,attachments=0,errors=0,closedPipes=0,codes:[String]=[],runtime:[String:Any]?
    var launchThrows=false,eofStops=false,nextExitOnSignal=true
    func nativeRecord(_ phase: String,_ code: String,attempt: Int? = nil) {codes.append(code)}
    func showError(_ title: String,_ detail: String) {errors += 1}
    func installerOwnsBackend() -> Bool {installer}
    func cancelChromePreparation() {}
    func setComputerPolling(_ enabled: Bool) {}
    func closeOwnerPipe() {closedPipes += 1;if eofStops,let process{process.isRunning=false;InstanceLifecycle.identities[process.processIdentifier]=nil}}
    func readRuntime() -> [String:Any]? {runtime}
    func attach(_ descriptor: [String:Any]) {attachments += 1;serviceAvailable=true}
    func startService() throws {
        if launchThrows {throw NSError(domain:"fixture",code:1)}
        starts += 1;runtime=nil
        let p=Process(Int32(1000+starts));p.exitOnSignal=nextExitOnSignal
        process=p;ownsService=true;interfaceKeyShared=true
        let identity=InstanceLifecycle.Identity(pid:p.processIdentifier,stamp:starts)
        InstanceLifecycle.identities[p.processIdentifier]=identity;Darwin.processes[p.processIdentifier]=p
        backendGeneration=UUID()
        observeBackendStartup(p,generation:backendGeneration,identity:identity)
    }
    // ACTUAL_OWNED_EXIT
    // ACTUAL_SCHEDULE_RECOVERY
    // ACTUAL_STARTUP_OBSERVER
    // ACTUAL_STARTUP_STOP
    func exit(_ p: Process,generation: UUID) {p.isRunning=false;InstanceLifecycle.identities[p.processIdentifier]=nil;ownedBackendExited(p,generation:generation)}
}

@main struct Checks {
    static func fresh() -> App {Scheduler.reset();Darwin.processes=[:];return App()}
    static func earlyExit() throws {
        let a=fresh();try a.startService();let p=a.process!,generation=a.backendGeneration,oldTimer=a.timer!
        a.exit(p,generation:generation);a.ownedBackendExited(p,generation:generation);oldTimer.deliverQueued()
        precondition(a.codes.filter{$0=="RECOVERY_SCHEDULED"}.count==1,"early exit and poll must schedule once")
        Scheduler.advance(0.5);precondition(a.starts==2 && a.process !== p)
        a.runtime=["pid":Int(a.process!.processIdentifier)];Scheduler.advance(0.25)
        precondition(a.attachments==1 && a.backendRecoveryInProgress==false)
    }
    static func lateReady() throws {
        let a=fresh();try a.startService();let p=a.process!,generation=a.backendGeneration,oldTimer=a.timer!
        Scheduler.advance(20);precondition(a.attachments==0 && a.closedPipes==1 && a.starts==1)
        a.runtime=["pid":Int(p.processIdentifier)];oldTimer.deliverQueued()
        precondition(a.attachments==0,"late ready must not attach a child already being stopped")
        Scheduler.advance(1.3);precondition(a.starts==1 && !p.isRunning,"replacement waits for confirmed child exit")
        a.ownedBackendExited(p,generation:generation);Scheduler.advance(0.5)
        precondition(a.starts==2 && Darwin.signals.count==1 && Darwin.signals[0].0==p.processIdentifier)
        oldTimer.deliverQueued();a.ownedBackendExited(p,generation:generation)
        precondition(a.starts==2 && a.attachments==0)
    }
    static func boundedTimeouts() throws {
        let a=fresh();a.eofStops=true;try a.startService();Scheduler.advance(120)
        precondition(a.starts==4,"initial launch plus at most three replacement starts, even with 20s failures")
        precondition(a.codes.filter{$0=="RECOVERY_EXHAUSTED"}.count==1 && a.errors==1)
        Scheduler.advance(180);precondition(a.starts==4,"wall clock alone cannot reset an unattached episode")
    }
    static func boundedEarlyExits() throws {
        let a=fresh();try a.startService()
        for delay in [0.5,1.0,2.0] {a.exit(a.process!,generation:a.backendGeneration);Scheduler.advance(delay)}
        a.exit(a.process!,generation:a.backendGeneration);Scheduler.advance(180)
        precondition(a.starts==4 && a.codes.contains("RECOVERY_EXHAUSTED"))
    }
    static func unconfirmedStop() throws {
        let a=fresh();a.nextExitOnSignal=false;try a.startService();let p=a.process!
        Scheduler.advance(26)
        precondition(a.starts==1 && p.isRunning && a.errors==1 && a.codes.contains("STARTUP_STOP_UNCONFIRMED"))
        precondition(Darwin.signals.map{$0.1}==[SIGTERM,SIGKILL])
        Scheduler.advance(120);precondition(a.starts==1)
    }
    static func launchErrors() throws {
        let a=fresh();try a.startService();a.exit(a.process!,generation:a.backendGeneration)
        a.launchThrows=true;Scheduler.advance(180)
        precondition(a.starts==1 && a.errors==1 && a.codes.filter{$0=="RECOVERY_SCHEDULED"}.count==3 && a.codes.contains("RECOVERY_EXHAUSTED"),"synchronous replacement launch errors use the same finite budget")
    }
    static func identityAndOwnership() throws {
        let a=fresh();try a.startService();let p=a.process!
        InstanceLifecycle.identities[p.processIdentifier]=InstanceLifecycle.Identity(pid:p.processIdentifier,stamp:99)
        Scheduler.advance(24)
        precondition(a.starts==1 && Darwin.signals.isEmpty && a.codes.contains("STARTUP_IDENTITY_UNKNOWN"))
        let k=fresh();k.nextExitOnSignal=false;try k.startService();Scheduler.advance(21.3)
        precondition(Darwin.signals.map{$0.1}==[SIGTERM])
        InstanceLifecycle.identities[k.process!.processIdentifier]=InstanceLifecycle.Identity(pid:k.process!.processIdentifier,stamp:99)
        Scheduler.advance(3)
        precondition(k.starts==1 && Darwin.signals.map{$0.1}==[SIGTERM] && k.codes.contains("STARTUP_IDENTITY_UNKNOWN"),"identity must be checked again before escalating to KILL")
        let b=fresh();try b.startService();let old=b.process!,generation=b.backendGeneration
        b.ownsService=false;Scheduler.advance(30);b.exit(old,generation:generation)
        precondition(b.starts==1 && b.closedPipes==0 && Darwin.signals.isEmpty && b.attachments==0)
        let c=fresh();try c.startService();let current=c.process!,currentGeneration=c.backendGeneration
        c.ownedBackendExited(current,generation:currentGeneration)
        precondition(c.starts==1 && c.process === current,"running child cannot be treated as exited")
        c.exit(Process(9999),generation:currentGeneration);c.exit(current,generation:UUID())
        precondition(c.starts==1 && c.process === current,"foreign/stale process never grants recovery authority")
    }
    static func races() throws {
        for race in ["quit","uninstall","installer"] {
            let a=fresh();try a.startService();let p=a.process!,generation=a.backendGeneration
            a.exit(p,generation:generation)
            if race=="quit"{a.shuttingDown=true}else if race=="uninstall"{a.uninstallInProgress=true}else{a.installer=true}
            Scheduler.advance(30);precondition(a.starts==1 && a.attachments==0,"scheduled recovery respects new suppression")
            let b=fresh();try b.startService();Scheduler.advance(20)
            if race=="quit"{b.shuttingDown=true}else if race=="uninstall"{b.uninstallInProgress=true}else{b.installer=true}
            b.runtime=["pid":Int(b.process!.processIdentifier)];Scheduler.advance(10)
            precondition(b.starts==1 && b.attachments==0 && Darwin.signals.isEmpty,"stop timer cannot signal or attach after suppression")
        }
    }
    static func exactRuntimeAndReset() throws {
        let a=fresh();try a.startService();a.runtime=["pid":99999];Scheduler.advance(1)
        precondition(a.attachments==0)
        a.runtime=["pid":Int(a.process!.processIdentifier)];Scheduler.advance(0.25)
        precondition(a.attachments==1)
        let late=fresh();try late.startService();Scheduler.advance(19.5)
        late.runtime=["pid":Int(late.process!.processIdentifier)];Scheduler.advance(0.25)
        precondition(late.attachments==1 && late.starts==1 && Darwin.signals.isEmpty,"late but timely readiness still attaches")
        // Real attachment ends the startup episode but does not erase the
        // existing rolling protection against fast attached crash loops.
        var policy=BackendRecoveryPolicy()
        precondition(policy.recoveryDelay(now:0)==0.5)
        precondition(policy.recoveryDelay(now:21)==1)
        precondition(policy.recoveryDelay(now:42)==2)
        precondition(policy.recoveryDelay(now:63)==nil)
        policy.attached();precondition(policy.recoveryDelay(now:64) != nil)
        var rapid=BackendRecoveryPolicy()
        for time in [1.0,2.0,3.0] {precondition(rapid.recoveryDelay(now:time) != nil);rapid.attached()}
        precondition(rapid.recoveryDelay(now:4)==nil)
    }
    static func main() throws {
        let requested=CommandLine.arguments.dropFirst().first ?? "all"
        let cases:[(String,() throws -> Void)]=[("early-exit",earlyExit),("late-ready",lateReady),("bounded-timeouts",boundedTimeouts),("bounded-early-exits",boundedEarlyExits),("unconfirmed-stop",unconfirmedStop),("launch-errors",launchErrors),("identity",identityAndOwnership),("races",races),("runtime-reset",exactRuntimeAndReset)]
        for (name,check) in cases where requested=="all" || requested==name {try check();print("PASS: "+name)}
    }
}
