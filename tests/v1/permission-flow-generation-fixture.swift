import Foundation
import CoreFoundation

// Complete production class is injected below. All system/vendor boundaries are
// inert fakes; even an accidental process request fails before launching anything.
var axTrusted=false,recordingTrusted=false,recordingRequests=0,axRequests=0
func AXIsProcessTrusted()->Bool { axTrusted }
func CGRequestScreenCaptureAccess()->Bool { recordingRequests += 1;return recordingTrusted }
struct FakeKey {func takeUnretainedValue()->String { "fake-key" }}
let kAXTrustedCheckOptionPrompt=FakeKey()
func AXIsProcessTrustedWithOptions(_ options:CFDictionary)->Bool { axRequests += 1;return axTrusted }
enum LocalText {static let systemLocale="en";static func text(_ key:String)->String {key}}
enum BuildVersion {static let bundleID="com.kenyu.chathand"}
struct PermissionFlowConfiguration {let requiredAppURLs:[URL];let promptForAccessibilityTrust:Bool;let localeIdentifier:String}
enum Pane:Equatable {case accessibility,screenRecording}
final class PermissionFlowController {
 static var latest:PermissionFlowController?
 var panes:[Pane]=[],closed=0
 init(){Self.latest=self}
 func setLocaleIdentifier(_ s:String){}
 func authorize(pane:Pane,suggestedAppURLs:[URL]){panes.append(pane)}
 func closePanel(){closed += 1}
}
enum PermissionFlow {static func makeController(configuration:PermissionFlowConfiguration)->PermissionFlowController {PermissionFlowController()}}
enum PermissionFlowScreenRecordingStatus {static func register(){}}
enum Authorization {case granted,notGranted}
struct Provider {let pane:Pane;func authorizationState()->Authorization {(pane == .accessibility ? axTrusted:recordingTrusted) ? .granted:.notGranted}}
enum PermissionStatusRegistry {static func provider(for pane:Pane)->Provider {Provider(pane:pane)}}
final class Timer {
 static var latest:Timer?,created=0
 var isValid=true
 let work:(Timer)->Void
 init(_ work:@escaping(Timer)->Void){self.work=work}
 static func scheduledTimer(withTimeInterval:TimeInterval,repeats:Bool,_ work:@escaping(Timer)->Void)->Timer {let t=Timer(work);latest=t;created += 1;return t}
 func invalidate(){isValid=false}
 func fire(){precondition(isValid,"only fire a timer while valid");work(self)}
}
final class NSAlert {var messageText="",informativeText="";func addButton(withTitle:String){};enum Reply {case alertFirstButtonReturn,cancel};func runModal()->Reply {.cancel}}
final class Process {var executableURL:URL?,arguments:[String]?,terminationStatus:Int32=0;func run()throws {fatalError("process forbidden")};func waitUntilExit(){fatalError("process forbidden")}}

/*__PRODUCTION_CLASS__*/

@main struct Checks {
 @MainActor static var checks=0,failures=0
 @MainActor static func expect(_ condition:Bool,_ label:String){checks += 1;if !condition{failures += 1;print("FAIL: "+label)}}
 @MainActor static func reset(){axTrusted=false;recordingTrusted=false;recordingRequests=0;axRequests=0;Timer.latest=nil;Timer.created=0}
 @MainActor static func drain() async {for _ in 0..<30 {await Task.yield()}}
 @MainActor static func main() async {
  for granted in [true,false] {
   reset();let assistant=PermissionAssistant();var updates=0
   _ = assistant.requestPermissions(onUpdate:{_ in updates += 1});let old=Timer.latest!;old.fire()
   _ = assistant.requestAccessibilityOnly();expect(!old.isValid,"AX-only invalidates old timer")
   axTrusted=true;assistant.finishAccessibilityOnly(granted:granted);let panes=PermissionFlowController.latest!.panes
   await drain()
   expect(recordingRequests==0,"queued old Task after AX grant/cancel cannot request recording")
   expect(PermissionFlowController.latest!.panes==panes,"AX finish cannot reopen a generic panel")
   expect(updates==0,"AX-only drops old generic update callback")
  }
  do {
   reset();let assistant=PermissionAssistant();var oldUpdates=0,newUpdates=0
   _ = assistant.requestPermissions(onUpdate:{_ in oldUpdates += 1});let old=Timer.latest!;old.fire()
   _ = assistant.requestPermissions(onUpdate:{_ in newUpdates += 1});let current=Timer.latest!
   expect(old !== current && !old.isValid && current.isValid,"new generic request rebuilds timer with its own token")
   await drain();expect(oldUpdates==0 && newUpdates==0,"old generic Task cannot call new flow update")
   axTrusted=true;current.fire();await drain()
   expect(recordingRequests==1 && newUpdates==1,"new generic flow still advances AX to recording and updates")
   recordingTrusted=true;current.fire();await drain()
   expect(!current.isValid && assistant.status()["complete"] as? Bool == true,"generic completion cleans up current timer")
   expect(newUpdates==2,"generic completion retains its update callback")
  }
  do {
   reset();let assistant=PermissionAssistant();var updates=0
   _ = assistant.requestPermissions(onUpdate:{_ in updates += 1});let old=Timer.latest!
   _ = assistant.requestAccessibilityOnly();axTrusted=true;assistant.finishAccessibilityOnly(granted:true)
   _ = assistant.reopenGuidance();let current=Timer.latest
   expect(current !== old && current?.isValid == true,"reopen after AX-only explicitly restores generic polling")
   recordingTrusted=true;if let current,current.isValid{current.fire()};await drain()
   expect(assistant.status()["complete"] as? Bool == true,"reopened flow observes permission completion")
   expect(current?.isValid == false,"reopened timer stops after completion")
   expect(updates==0,"AX-only-cleared generic callback is not revived by reopen")
  }
  do {
   reset();let assistant=PermissionAssistant();var updates=0
   _ = assistant.requestPermissions(onUpdate:{_ in updates += 1});let first=Timer.latest!
   axTrusted=true;recordingTrusted=true;first.fire();await drain();expect(!first.isValid,"completed generic timer invalidates")
   recordingTrusted=false;_ = assistant.reopenGuidance();let reopened=Timer.latest
   expect(reopened !== first && reopened?.isValid == true,"reopen after completed generic flow creates fresh polling")
   recordingTrusted=true;if let reopened,reopened.isValid{reopened.fire()};await drain()
   expect(updates==2,"reopen preserves explicit generic update callback")
  }
  do {
   reset();let assistant=PermissionAssistant();var updates=0
   _ = assistant.requestPermissions(onUpdate:{_ in updates += 1});let old=Timer.latest!;old.fire()
   axTrusted=true;recordingTrusted=true;_ = assistant.requestPermissions(onUpdate:{_ in updates += 100})
   await drain();expect(updates==0,"immediate complete generic request invalidates old queued Tasks")
   expect(!old.isValid,"immediate complete request invalidates its previous timer")
  }
  do {
   reset();let assistant=PermissionAssistant();var updates=0
   _ = assistant.requestPermissions(onUpdate:{_ in updates += 1;if updates==1{recordingTrusted=false}});let timer=Timer.latest!
   timer.fire();timer.fire();axTrusted=true;recordingTrusted=true;await drain()
   expect(updates==1 && recordingRequests==0,"generic completion revokes all other Tasks already queued by same timer")
  }
  do {
   reset();let assistant=PermissionAssistant();_ = assistant.requestAccessibilityOnly()
   var updates=0;_ = assistant.requestPermissions(onUpdate:{_ in updates += 1});let generic=Timer.latest!
   assistant.finishAccessibilityOnly(granted:false)
   axTrusted=true;generic.fire();await drain()
   expect(generic.isValid && updates==1 && recordingRequests==1,"late AX-only finish cannot revoke newer explicit generic flow")
  }
  do {
   reset();let assistant=PermissionAssistant();_ = assistant.requestPermissions(onUpdate:{_ in});let old=Timer.latest!;old.fire()
   _ = assistant.reopenGuidance();let current=Timer.latest!
   expect(old !== current && !old.isValid,"reopen active generic flow also rebuilds its timer")
   await drain();expect(recordingRequests==0,"old queued generic cannot advance new reopened flow")
   axTrusted=true;current.fire();await drain();expect(recordingRequests==1,"current reopened flow remains authorized to advance")
  }
  do {
   reset();let assistant=PermissionAssistant();_ = assistant.requestAccessibilityOnly();_ = assistant.reopenGuidance()
   expect(Timer.created==0 && recordingRequests==0,"reopen while AX-only stays AX-only without generic polling")
   expect(PermissionFlowController.latest!.panes == [.accessibility,.accessibility],"AX-only reopen retains its same permission pane")
   assistant.finishAccessibilityOnly(granted:false);await drain()
  }
  expect(PermissionFlowState.advance(from:.complete,accessibilityGranted:true,screenRecordingGranted:false) == .screenRecording,"production complete state remains usable by explicit later generic flows")
  print("RESULT: \(checks) checks; \(failures) failures; actual complete production class + actual state helper; fake system boundaries only")
  if failures>0 {exit(1)}
 }
}
