import Foundation
import Darwin

// Built explicitly before the Node run; these operations never signal a real PID.
@main struct ExactAppProcessTests {
 final class Sample {
  var alive: [Bool], starts: [ExactAppProcess.Start?], paths: [String?]
  var aliveReads = 0, startReads = 0, pathReads = 0, signals = 0, pauses = 0
  var unknownAt: Int? = nil
  var denySignal = false
  var isZombie = false
  init(_ alive: [Bool], _ starts: [ExactAppProcess.Start?], _ paths: [String?]) {
   self.alive = alive; self.starts = starts; self.paths = paths
  }
  func value<T>(_ items: [T], _ index: Int) -> T {
   precondition(!items.isEmpty, "unexpected system read")
   return items[min(index, items.count - 1)]
  }
  var operations: ExactAppProcess.Operations {
   ExactAppProcess.Operations(alive: { pid in
    precondition(pid == 4242); self.aliveReads += 1
    if self.unknownAt == self.aliveReads { throw ExactAppProcess.Invalid(code: "PID_STATUS_UNKNOWN") }
    return self.value(self.alive, self.aliveReads - 1)
   }, zombie: { pid in
    precondition(pid == 4242); return self.isZombie
   }, path: { pid in
    precondition(pid == 4242); self.pathReads += 1
    return self.value(self.paths, self.pathReads - 1)
   }, start: { pid in
    precondition(pid == 4242); self.startReads += 1
    return self.value(self.starts, self.startReads - 1)
   }, terminate: { pid in
    precondition(pid == 4242); self.signals += 1
    if self.denySignal { throw ExactAppProcess.Invalid(code: "EXACT_STOP_DENIED") }
   }, now: { Date(timeIntervalSince1970: Double(self.pauses)) }, pause: { self.pauses += 1 })
  }
 }
 static func check(_ condition: @autoclosure () -> Bool, _ message: String) {
  precondition(condition(), message)
 }
 static func main() throws {
  let fm = FileManager.default
  let root = fm.temporaryDirectory.appendingPathComponent("exact-app-process-" + UUID().uuidString)
  let app = root.appendingPathComponent("Fixture.app")
  let binary = app.appendingPathComponent("Contents/MacOS/Fixture")
  try fm.createDirectory(at: binary.deletingLastPathComponent(), withIntermediateDirectories: true)
  defer { try? fm.removeItem(at: root) }
  try Data().write(to: binary)
  let plist: [String: String] = ["CFBundleExecutable": "Fixture", "CFBundleIdentifier": "invalid.chathand.stop-unit", "CFBundlePackageType": "APPL"]
  try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: app.appendingPathComponent("Contents/Info.plist"))
  let physicalApp = URL(fileURLWithPath: RehearsalIsolation.physical(app.path)!)
  let expected = try ExactAppProcess.executable(physicalApp)
  let original = ExactAppProcess.Start(seconds: 100, microseconds: 1)
  let reused = ExactAppProcess.Start(seconds: 101, microseconds: 1)
  let reusedMicrosecond = ExactAppProcess.Start(seconds: 100, microseconds: 2)
  var passed: [String] = []
  func success(_ name: String, _ sample: Sample, signals: Int, alreadyGone: Bool = false) throws {
   let result = try ExactAppProcess.stop(physicalApp, 4242, operations: sample.operations)
   check(result["stopped"] as? Bool == true && result["pid_absent"] as? Bool == true, name + ": absence required")
   check((result["already_gone"] as? Bool ?? false) == alreadyGone, name + ": initial state")
   check(sample.signals == signals, name + ": signal count")
   passed.append(name)
  }
  func failure(_ name: String, _ sample: Sample, _ code: String, signals: Int) throws {
   do { _ = try ExactAppProcess.stop(physicalApp, 4242, operations: sample.operations); preconditionFailure(name + ": must refuse") }
   catch let error as ExactAppProcess.Invalid { check(error.code == code, name + ": " + error.code) }
   check(sample.signals == signals, name + ": signal count")
   passed.append(name)
  }
  try success("already absent does not signal", Sample([false], [], []), signals: 0, alreadyGone: true)
  try success("normal SIGTERM exit", Sample([true, false], [original, original], [expected]), signals: 1)
  try success("exit before initial start read", Sample([true, false], [nil], []), signals: 0, alreadyGone: true)
  try success("exit during polling start read", Sample([true, true, false], [original, original, nil], [expected]), signals: 1)
  try success("exit during polling path read", Sample([true, true, false], [original], [expected, nil]), signals: 1)
  try success("exit during polling final start read", Sample([true, true, false], [original, original, original, nil], [expected]), signals: 1)
  try failure("unreadable live identity is not absence", Sample([true], [original, original, nil], [expected]), "PID_INSPECTION_UNAVAILABLE", signals: 1)
  let zombie = Sample([true], [original, original, nil], [expected]); zombie.isZombie = true
  try success("zombie after SIGTERM is already exited", zombie, signals: 1)
  let unknown = Sample([true], [original, original, nil], [expected]); unknown.unknownAt = 3
  try failure("unknown status is not absence", unknown, "PID_STATUS_UNKNOWN", signals: 1)
  try failure("PID reuse during initial identity read", Sample([true], [original, reused], [expected]), "PID_IDENTITY_CHANGED", signals: 0)
  try failure("PID reuse after SIGTERM", Sample([true], [original, original, reused, reused], [expected]), "PID_IDENTITY_CHANGED", signals: 1)
  try failure("same-second PID reuse after SIGTERM", Sample([true], [original, original, reusedMicrosecond, reusedMicrosecond], [expected]), "PID_IDENTITY_CHANGED", signals: 1)
  try failure("executable changes after SIGTERM", Sample([true], [original], [expected, "/unrelated/process"]), "PID_IDENTITY_CHANGED", signals: 1)
  try failure("wrong executable never receives SIGTERM", Sample([true], [original], ["/unrelated/process"]), "PID_IDENTITY_CHANGED", signals: 0)
  let denied = Sample([true], [original], [expected]); denied.denySignal = true
  try failure("SIGTERM denial remains failure", denied, "EXACT_STOP_DENIED", signals: 1)
  let timeout = Sample([true], [original], [expected])
  try failure("survivor times out without escalation", timeout, "EXACT_STOP_TIMEOUT", signals: 1)
  check(timeout.pauses == 8, "bounded original deadline")
  let data = try JSONSerialization.data(withJSONObject: ["passed": passed.count, "cases": passed], options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
 }
}
