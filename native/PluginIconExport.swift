import Foundation
import ImageIO
import UniformTypeIdentifiers
import Darwin

enum PluginIconExport {
    enum Failure: String, Error { case invalid = "PLUGIN_ICON_INVALID", collision = "PLUGIN_ICON_FILE_COLLISION", copy = "PLUGIN_ICON_COPY_FAILED" }
    static func bytes(_ file: URL) throws -> Data {
        var st = stat()
        guard lstat(file.path, &st) == 0, st.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), st.st_nlink == 1, st.st_size > 0, st.st_size <= 10 * 1024 else { throw Failure.invalid }
        let data = try Data(contentsOf: file)
        guard data.count <= 10 * 1024, let image = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetType(image) as String? == UTType.png.identifier,
              let props = CGImageSourceCopyPropertiesAtIndex(image, 0, nil) as? [String: Any],
              props[kCGImagePropertyPixelWidth as String] as? Int == 256,
              props[kCGImagePropertyPixelHeight as String] as? Int == 256 else { throw Failure.invalid }
        return data
    }
    static func copy(source: URL, downloads: URL) throws -> URL {
        let data = try bytes(source), fm = FileManager.default
        try fm.createDirectory(at: downloads, withIntermediateDirectories: true)
        for suffix in 1...99 {
            let file = downloads.appendingPathComponent("ChatHand-icon" + (suffix == 1 ? "" : "-\(suffix)") + ".png")
            var st = stat()
            if lstat(file.path, &st) == 0 {
                if st.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), st.st_nlink == 1, (try? bytes(file)) == data { return file }
                continue
            }
            guard errno == ENOENT else { throw Failure.copy }
            do { try data.write(to: file, options: .withoutOverwriting) } catch { if fm.fileExists(atPath: file.path) { continue }; throw Failure.copy }
            guard try bytes(file) == data else { throw Failure.copy }; return file
        }
        throw Failure.collision
    }
}
