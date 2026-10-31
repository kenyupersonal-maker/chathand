import Foundation
import Darwin
import ImageIO
import CoreGraphics

// Pure/temp-only. It never launches the App, prompts for a permission,
// opens an existing workspace, or uses a production state directory.
@main
struct ArtifactFileAccessTests {
    static var count = 0
    static func check(_ condition: @autoclosure () throws -> Bool, _ label: String) {
        do { let value = try condition(); precondition(value, label); count += 1 }
        catch { preconditionFailure("unexpected fixture error") }
    }
    static func failure(_ code: ArtifactIOError, _ body: () throws -> Void) {
        do { try body(); preconditionFailure("expected fixed refusal") }
        catch let actual as ArtifactIOError { check(actual == code, "wrong fixed refusal") }
        catch { preconditionFailure("non-protocol error") }
    }
    static func identity(_ url: URL) throws -> [String: Any] {
        var s = stat(); guard lstat(url.path, &s) == 0 else { throw ArtifactIOError.io }
        return ["dev": String(s.st_dev), "ino": String(s.st_ino)]
    }
    static func image(_ type: String) throws -> Data {
        guard let context = CGContext(data: nil, width: 4, height: 3, bitsPerComponent: 8, bytesPerRow: 16, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw ArtifactIOError.io }
        context.setFillColor(CGColor(red: 0.3, green: 0.6, blue: 0.9, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: 4, height: 3))
        guard let raster = context.makeImage() else { throw ArtifactIOError.io }; let data = NSMutableData()
        guard let writer = CGImageDestinationCreateWithData(data, type as CFString, 1, nil) else { throw ArtifactIOError.image }
        CGImageDestinationAddImage(writer, raster, [:] as CFDictionary); guard CGImageDestinationFinalize(writer) else { throw ArtifactIOError.image }; return data as Data
    }
    static func main() throws {
        let fm = FileManager.default, base = fm.temporaryDirectory.appendingPathComponent("chathand-artifact-pure-" + UUID().uuidString.lowercased(), isDirectory: true)
        try fm.createDirectory(at: base, withIntermediateDirectories: false)
        defer { try? fm.removeItem(at: base) }
        let workspace = base.appendingPathComponent("workspace", isDirectory: true), outside = base.appendingPathComponent("own-other", isDirectory: true)
        try fm.createDirectory(at: workspace, withIntermediateDirectories: false); try fm.createDirectory(at: outside, withIntermediateDirectories: false)
        let binding: [String: Any] = ["version": 1, "root": workspace.path, "root_identity": try identity(workspace)]
        func call(_ action: String, _ fields: [String: Any] = [:]) throws -> [String: Any] { var body = binding; body["action"] = action; body.merge(fields) { _, next in next }; return try ArtifactFileAccess.handle(body) }
        let id = UUID().uuidString.lowercased(), destination = "成果/本轮-" + String(id.prefix(8)) + "/" + id, text = Data("hello 中文".utf8)
        let fields: [String: Any] = ["operation_id": id, "destination": destination]
        func operation(_ action: String, _ extra: [String: Any] = [:]) throws -> [String: Any] { var f = fields; f.merge(extra) { _, next in next }; return try call(action, f) }
        let staged = try operation("stage", ["source_sha256": ArtifactFileAccess.digest(text), "entries": [["path": "中文/第一页.txt", "data_base64": text.base64EncodedString()]]])
        check(staged["status"] as? String == "staged", "stage phase"); check(!fm.fileExists(atPath: workspace.appendingPathComponent(destination).path), "stage does not publish")
        let sum = staged["manifest_sha256"] as! String
        let repeated = try operation("stage", ["entries": [["path": "中文/第一页.txt", "data_base64": text.base64EncodedString()]]])
        check(repeated["replayed"] as? Bool == true, "same chunk no input replay")
        failure(.intent) { _ = try operation("stage", ["entries": [["path": "中文/第一页.txt", "data_base64": Data("changed".utf8).base64EncodedString()]]]) }
        failure(.intent) { _ = try operation("stage", ["chunk_index": 2, "expected_manifest_sha256": sum, "entries": [["path": "gap.txt", "data_base64": text.base64EncodedString()]]]) }
        let png = try image("public.png"), appended = try operation("stage", ["chunk_index": 1, "expected_manifest_sha256": sum, "entries": [["path": "第二页.png", "data_base64": png.base64EncodedString()]]])
        check(appended["count"] as? Int == 2, "chunk append")
        let finalSum = appended["manifest_sha256"] as! String
        failure(.intent) { _ = try operation("commit", ["manifest_sha256": sum]) }
        let applied = try operation("commit", ["manifest_sha256": finalSum])
        check(applied["status"] as? String == "applied", "one publish"); check(applied["manifest_sha256"] as? String == finalSum, "same manifest")
        check(try operation("commit", ["manifest_sha256": finalSum])["replayed"] as? Bool == true, "commit uncertain reconcile no publish replay")
        check(try operation("inspect", ["manifest_sha256": finalSum])["status"] as? String == "applied", "inspect actual receipt")
        let path = destination + "/第二页.png", thumb = try call("thumbnail", ["path": path, "sha256": ArtifactFileAccess.digest(png)])
        check(thumb["available"] as? Bool == true, "real png thumbnail"); check(thumb["width"] as? Int == 4 && thumb["height"] as? Int == 3, "real dimensions")
        check((thumb["image_base64"] as? String)?.count ?? Int.max < 180000, "bounded thumbnail")
        let decoded = Data(base64Encoded: thumb["image_base64"] as! String)!, source = CGImageSourceCreateWithData(decoded as CFData, nil)
        check(source != nil && CGImageSourceCreateImageAtIndex(source!, 0, nil) != nil, "actual output decodes")
        let original = try call("verify", ["path": destination + "/中文/第一页.txt"])
        check(original["sha256"] as? String == ArtifactFileAccess.digest(text), "actual SHA"); check(original["needs_confirmation"] as? Bool == false, "ordinary open")
        failure(.hash) { _ = try call("verify", ["path": destination + "/中文/第一页.txt", "sha256": String(repeating: "0", count: 64)]) }
        failure(.path) { _ = try call("verify", ["path": "../own-other/secret"] ) }
        let target = workspace.appendingPathComponent("plain.txt"); try text.write(to: target)
        try fm.createSymbolicLink(atPath: workspace.appendingPathComponent("linked.txt").path, withDestinationPath: target.path)
        failure(.link) { _ = try call("verify", ["path": "linked.txt"]) }
        check(link(target.path, workspace.appendingPathComponent("hard.txt").path) == 0, "own hardlink fixture")
        failure(.link) { _ = try call("verify", ["path": "plain.txt"]) }
        try fm.removeItem(at: workspace.appendingPathComponent("hard.txt"))
        try fm.createSymbolicLink(atPath: workspace.appendingPathComponent("alias-dir").path, withDestinationPath: outside.path)
        failure(.link) { _ = try call("verify", ["path": "alias-dir/new.txt"]) }
        failure(.link) { var b = binding; b["action"] = "inspect"; b["root"] = workspace.appendingPathComponent("alias-dir").path; b["root_identity"] = try identity(outside); b.merge(fields) { _, n in n }; _ = try ArtifactFileAccess.handle(b) }
        let bad = workspace.appendingPathComponent("bad.png"); try Data([137,80,78,71,13,10,26,10,0]).write(to: bad)
        let broken = try call("thumbnail", ["path": "bad.png"])
        check(broken["available"] as? Bool == false && broken["width"] == nil, "bad image icon no invented dimensions")
        let jpeg = try image("public.jpeg"); try jpeg.write(to: workspace.appendingPathComponent("photo.jpg"))
        check(try call("thumbnail", ["path": "photo.jpg"])["available"] as? Bool == true, "real jpeg decode")
        try Data("<svg onload='anything'/>".utf8).write(to: workspace.appendingPathComponent("vector.svg"))
        check(try call("thumbnail", ["path": "vector.svg"])["available"] as? Bool == false, "SVG not executed")
        let webp = Data(base64Encoded: "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA")!
        try webp.write(to: workspace.appendingPathComponent("tiny.webp"))
        let webpThumb = try call("thumbnail", ["path": "tiny.webp"])
        check(webpThumb["available"] as? Bool == true || webpThumb["width"] == nil, "webp decode or explicit icon only")
        let script = workspace.appendingPathComponent("open.sh"); try text.write(to: script)
        check(try call("verify", ["path": "open.sh"])["needs_confirmation"] as? Bool == true, "risky open needs personal approval")
        let downloads = base.appendingPathComponent("owned-downloads", isDirectory: true); try fm.createDirectory(at: downloads, withIntermediateDirectories: false)
        let downloaded = downloads.appendingPathComponent("本轮.zip"); try text.write(to: downloaded); var s = stat(); check(lstat(downloaded.path, &s) == 0, "read fixture stat")
        var readRequest: [String: Any] = ["version": 1, "action": "read", "root": downloads.path, "root_identity": try identity(downloads), "path": "本轮.zip", "expected_identity": ["dev": String(s.st_dev), "ino": String(s.st_ino), "size": String(s.st_size)], "max_bytes": 50 * 1024 * 1024]
        let read = try ArtifactFileAccess.handle(readRequest)
        check(read["data_base64"] as? String == text.base64EncodedString(), "exact readonly source"); check(fm.fileExists(atPath: downloaded.path), "read preserves source")
        var archiveRequest = readRequest; archiveRequest["action"] = "archive-download"; archiveRequest["operation_id"] = id
        archiveRequest["sha256"] = ArtifactFileAccess.digest(text); archiveRequest["archive_day"] = "2026-10-08"
        archiveRequest["committed"] = ["root": workspace.path, "root_identity": try identity(workspace), "destination": destination, "manifest_sha256": finalSum]
        let archived = try ArtifactFileAccess.handle(archiveRequest)
        check(archived["status"] as? String == "archived", "exact submitted source archived"); check(!fm.fileExists(atPath: downloaded.path), "source moved not final copy")
        let archivedPath = downloads.appendingPathComponent(archived["archive_path"] as! String)
        check(try Data(contentsOf: archivedPath) == text, "recoverable source unchanged")
        archiveRequest["action"] = "inspect-source"
        check(try ArtifactFileAccess.handle(archiveRequest)["status"] as? String == "archived", "source unknown query no move")
        try text.write(to: downloaded)
        archiveRequest["action"] = "archive-download"
        failure(.hash) { _ = try ArtifactFileAccess.handle(archiveRequest) }
        check(fm.fileExists(atPath: downloaded.path), "replacement never moved")
        readRequest["expected_identity"] = ["dev": String(s.st_dev), "ino": String(s.st_ino), "size": "0"]
        failure(.hash) { _ = try ArtifactFileAccess.handle(readRequest) }
        // Same-name replacement must not be removed by cancellation.
        let cancelID = UUID().uuidString.lowercased(), cancelDest = "成果/cancel/" + cancelID
        let c: [String: Any] = ["operation_id": cancelID, "destination": cancelDest, "entries": [["path": "own.txt", "data_base64": text.base64EncodedString()]]]
        _ = try call("stage", c)
        let privateFolder = workspace.appendingPathComponent(".chathand-artifact-stage-" + cancelID)
        let owned = privateFolder.appendingPathComponent("own.txt"); try fm.moveItem(at: owned, to: privateFolder.appendingPathComponent("original.txt")); try text.write(to: owned)
        failure(.hash) { _ = try call("cancel", ["operation_id": cancelID, "destination": cancelDest]) }
        check(fm.fileExists(atPath: owned.path), "cancel preserves replaced file")
        try fm.removeItem(at: owned); try fm.moveItem(at: privateFolder.appendingPathComponent("original.txt"), to: owned)
        _ = try call("cancel", ["operation_id": cancelID, "destination": cancelDest]); check(!fm.fileExists(atPath: privateFolder.path), "cancel removes exact owned staging")
        let foreignID = UUID().uuidString.lowercased(), foreignDest = "成果/foreign/" + foreignID
        _ = try call("stage", ["operation_id": foreignID, "destination": foreignDest, "entries": [["path": "own.txt", "data_base64": text.base64EncodedString()]]])
        let foreignFolder = workspace.appendingPathComponent(".chathand-artifact-stage-" + foreignID); try text.write(to: foreignFolder.appendingPathComponent("not-registered.txt"))
        failure(.intent) { _ = try call("cancel", ["operation_id": foreignID, "destination": foreignDest]) }
        check(fm.fileExists(atPath: foreignFolder.appendingPathComponent("not-registered.txt").path), "cancel preserves unregistered file")
        let collisionID = UUID().uuidString.lowercased(), occupied = "成果/collision/" + collisionID
        let collision = try call("stage", ["operation_id": collisionID, "destination": occupied, "entries": [["path": "safe.txt", "data_base64": text.base64EncodedString()]]])
        try fm.createDirectory(at: workspace.appendingPathComponent(occupied), withIntermediateDirectories: true)
        // A foreign destination lacks our manifest and is never overwritten.
        do { _ = try call("commit", ["operation_id": collisionID, "destination": occupied, "manifest_sha256": collision["manifest_sha256"]!]); preconditionFailure("collision overwritten") } catch { count += 1 }
        check(!fm.fileExists(atPath: workspace.appendingPathComponent(occupied + "/safe.txt").path), "no overwrite")
        let renamed = base.appendingPathComponent("old-workspace"); try fm.moveItem(at: workspace, to: renamed); try fm.createDirectory(at: workspace, withIntermediateDirectories: false)
        failure(.root) { _ = try call("inspect", fields) }
        print("ARTIFACT_PURE_PASS \(count) temp_only")
    }
}
