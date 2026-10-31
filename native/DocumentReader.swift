import Foundation
import PDFKit
import SQLite3
import CoreFoundation

@_silgen_name("ch_sqlite_descriptors")
func sqliteDescriptors(_ path: UnsafePointer<CChar>, _ mask: Int32) -> Int32

@_silgen_name("ch_sqlite_disable_extensions")
func disableSQLiteExtensions(_ db: OpaquePointer?) -> Int32
@_silgen_name("ch_sqlite_descriptor_error")
func sqliteDescriptorError() -> UnsafePointer<CChar>?

struct SQLiteReadError: Error { let detail: String }
let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

func readSQLite(_ raw: String) throws -> [String: Any] {
    guard let input = raw.data(using: .utf8), let o = try JSONSerialization.jsonObject(with: input) as? [String: Any],
          let path = o["path"] as? String, let mask = o["descriptor_mask"] as? Int32 else { throw SQLiteReadError(detail: "SQLITE_INPUT_INVALID") }
    let query = o["query"] as? String ?? "SELECT name, type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 200"
    guard query.unicodeScalars.count <= 8000, !query.utf8.contains(0) else { throw SQLiteReadError(detail: "QUERY_LIMIT") }
    let limit = o["limit"] as? Int ?? 100
    guard limit >= 1, limit <= 1000 else { throw SQLiteReadError(detail: "LIMIT_INVALID") }
    let setup = path.withCString { sqliteDescriptors($0, mask) }
    guard setup == SQLITE_OK else { throw SQLiteReadError(detail: "SQLITE_DESCRIPTOR_SETUP_\(setup)") }
    var db: OpaquePointer?
    let opened = sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX, "chathand-descriptors")
    defer { sqlite3_close(db) }
    func checked(_ rc: Int32) throws {
        guard rc == SQLITE_OK else { throw SQLiteReadError(detail: String(cString: sqliteDescriptorError() ?? sqlite3_errmsg(db))) }
    }
    try checked(opened)
    sqlite3_busy_timeout(db, 1000)
    // Extension loading starts disabled; explicitly keep it disabled where the
    // system build exposes the switch. The authorizer also denies its function.
    _ = disableSQLiteExtensions(db)
    try checked(sqlite3_exec(db, "PRAGMA query_only=ON; PRAGMA temp_store=MEMORY", nil, nil, nil))
    sqlite3_set_authorizer(db, { _, action, a, b, database, _ in
        guard [SQLITE_SELECT, SQLITE_READ, SQLITE_FUNCTION, SQLITE_RECURSIVE].contains(action) else { return SQLITE_DENY }
        if action == SQLITE_FUNCTION {
            let name = b ?? a
            if let name, ["load_extension", "readfile", "writefile"].contains(String(cString: name).lowercased()) { return SQLITE_DENY }
        }
        if action == SQLITE_READ, let database, String(cString: database) != "main" { return SQLITE_DENY }
        return SQLITE_OK
    }, nil)
    let deadline = UnsafeMutablePointer<Double>.allocate(capacity: 1)
    deadline.initialize(to: ProcessInfo.processInfo.systemUptime + 2)
    defer { sqlite3_progress_handler(db, 0, nil, nil); deadline.deinitialize(count: 1); deadline.deallocate() }
    sqlite3_progress_handler(db, 1000, { pointer in
        guard let pointer else { return 1 }
        return ProcessInfo.processInfo.systemUptime > pointer.assumingMemoryBound(to: Double.self).pointee ? 1 : 0
    }, deadline)
    var statement: OpaquePointer?
    // sqlite3_prepare consumes exactly one statement. Reject a non-whitespace
    // tail with another statement, matching Python execute. SQL comments are OK.
    try query.withCString { sql in
        var tail: UnsafePointer<CChar>?
        try checked(sqlite3_prepare_v2(db, sql, -1, &statement, &tail))
        if let tail {
            var extra: OpaquePointer?
            let extraRC = sqlite3_prepare_v2(db, tail, -1, &extra, nil)
            defer { sqlite3_finalize(extra) }
            if extraRC != SQLITE_OK || extra != nil {
                sqlite3_finalize(statement); statement = nil
                throw SQLiteReadError(detail: "You can only execute one statement at a time.")
            }
        }
    }
    defer { sqlite3_finalize(statement) }
    guard let statement else { return ["format":"sqlite", "columns":[], "rows":[], "truncated":false, "read_only":true] }
    let parameterJSON = o["parameters"] as? String ?? "[]"
    guard let parameterData = parameterJSON.data(using: .utf8) else { throw SQLiteReadError(detail:"PARAMETERS_INVALID") }
    let parameters = try JSONSerialization.jsonObject(with: parameterData, options: [.fragmentsAllowed])
    let count = sqlite3_bind_parameter_count(statement)
    func bind(_ value: Any, _ index: Int32) throws {
        let rc: Int32
        if value is NSNull { rc = sqlite3_bind_null(statement, index) }
        else if let text = value as? String { rc = text.withCString { sqlite3_bind_text(statement, index, $0, Int32(text.utf8.count), sqliteTransient) } }
        else if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { rc = sqlite3_bind_int64(statement, index, number.boolValue ? 1 : 0) }
            else if String(cString:number.objCType).contains("f") || String(cString:number.objCType).contains("d") { rc = sqlite3_bind_double(statement,index,number.doubleValue) }
            else {
                guard let integer = Int64(number.stringValue) else { throw SQLiteReadError(detail:"PARAMETERS_INTEGER_OVERFLOW") }
                rc = sqlite3_bind_int64(statement, index, integer)
            }
        } else { throw SQLiteReadError(detail:"PARAMETERS_INVALID") }
        try checked(rc)
    }
    if let list = parameters as? [Any] {
        guard list.count == Int(count) else { throw SQLiteReadError(detail:"Incorrect number of bindings supplied.") }
        for (i,value) in list.enumerated() { try bind(value, Int32(i+1)) }
    } else if let map = parameters as? [String:Any] {
        if count > 0 { for i in 1...count {
            guard let cName = sqlite3_bind_parameter_name(statement,i) else { throw SQLiteReadError(detail:"Binding has no name.") }
            let key = String(cString:cName).dropFirst()
            guard let value = map[String(key)] else { throw SQLiteReadError(detail:"Missing named parameter.") }
            try bind(value,i)
        } }
    } else { throw SQLiteReadError(detail:"PARAMETERS_INVALID") }
    let columns = (0..<sqlite3_column_count(statement)).map { String(cString:sqlite3_column_name(statement,$0)) }
    var rows: [[Any]] = []; var truncated = false; var bytes = 0
    while true {
        let rc = sqlite3_step(statement)
        if rc == SQLITE_DONE { break }
        guard rc == SQLITE_ROW else { try checked(rc); break }
        if rows.count == limit { truncated = true; break }
        var row: [Any] = []
        for i in 0..<sqlite3_column_count(statement) {
            let value: Any
            switch sqlite3_column_type(statement,i) {
            case SQLITE_NULL: value = NSNull()
            case SQLITE_INTEGER: value = sqlite3_column_int64(statement,i)
            case SQLITE_FLOAT:
                let number=sqlite3_column_double(statement,i)
                guard number.isFinite else { throw SQLiteReadError(detail:"NONFINITE_SQLITE_VALUE") }
                value=number
            case SQLITE_BLOB:
                let size=Int(sqlite3_column_bytes(statement,i)); let blob=sqlite3_column_blob(statement,i)
                let data=blob.map { Data(bytes:$0,count:min(1024,size)) } ?? Data()
                value=["type":"blob", "bytes":size, "base64":data.base64EncodedString(), "truncated":size>1024] as [String:Any]
            default:
                let size=Int(sqlite3_column_bytes(statement,i))
                guard bytes+size <= 1024*1024 else { throw SQLiteReadError(detail:"OUTPUT_LIMIT_USE_SMALLER_RANGE") }
                guard let pointer=sqlite3_column_text(statement,i), let text=String(bytes:UnsafeBufferPointer(start:pointer,count:size),encoding:.utf8) else { throw SQLiteReadError(detail:"Could not decode SQLite text to UTF-8") }
                value=text
            }
            row.append(value)
        }
        bytes += try JSONSerialization.data(withJSONObject:row, options:[.fragmentsAllowed]).count
        guard bytes<=1024*1024 else { throw SQLiteReadError(detail:"OUTPUT_LIMIT_USE_SMALLER_RANGE") }
        rows.append(row)
    }
    return ["format":"sqlite", "columns":columns, "rows":rows, "truncated":truncated, "read_only":true]
}

if CommandLine.arguments.dropFirst().first == "--sqlite" {
    do {
        let result = try readSQLite(CommandLine.arguments.dropFirst(2).first ?? "{}")
        let data = try JSONSerialization.data(withJSONObject:result, options:[.sortedKeys, .fragmentsAllowed])
        guard data.count <= 1024*1024 else { throw SQLiteReadError(detail:"OUTPUT_LIMIT_USE_SMALLER_RANGE") }
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
        exit(0)
    } catch {
        let detail = (error as? SQLiteReadError)?.detail ?? String(describing:error)
        let result = ["error":["code":"DOCUMENT_READ_FAILED","detail":String(detail.prefix(300))]]
        let data = try! JSONSerialization.data(withJSONObject:result)
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10])); exit(1)
    }
}

let handle = FileHandle(fileDescriptor: 3, closeOnDealloc: false)
do {
    let data = try handle.read(upToCount: 64 * 1024 * 1024 + 1) ?? Data()
    guard data.count <= 64 * 1024 * 1024, let doc = PDFDocument(data: data) else {
        throw NSError(domain: "PDF_READ_FAILED", code: 1)
    }
    guard !doc.isLocked else { throw NSError(domain: "PDF_PASSWORD_REQUIRED", code: 2) }
    let offset = Int(CommandLine.arguments.dropFirst().first ?? "0") ?? 0
    let limit = Int(CommandLine.arguments.dropFirst(2).first ?? "10") ?? 10
    guard offset >= 0, limit >= 1, limit <= 20 else { throw NSError(domain: "PAGE_RANGE_INVALID", code: 3) }
    var pages: [[String: Any]] = []
    var bytes = 0
    var next = offset
    if offset < doc.pageCount {
        for i in offset..<min(doc.pageCount, offset + limit) {
            let text = doc.page(at: i)?.string ?? ""
            let clipped = String(text.prefix(60000))
            if bytes + clipped.utf8.count > 700000 { break }
            bytes += clipped.utf8.count
            pages.append(["page": i + 1, "text": clipped, "text_truncated": clipped.count < text.count, "needs_visual_review": text.isEmpty])
            next = i + 1
        }
    }
    let result: [String: Any] = ["format": "pdf", "page_count": doc.pageCount, "pages": pages,
        "next_offset": next < doc.pageCount ? next as Any : NSNull(),
        "note": "Embedded text only. Scanned pages and visual layout require separate review; OCR was not run."]
    let encoded = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    print(String(data: encoded, encoding: .utf8)!)
} catch {
    let result: [String: Any] = ["error": ["code": "PDF_READ_FAILED", "detail": (error as NSError).domain]]
    let encoded = try! JSONSerialization.data(withJSONObject: result)
    print(String(data: encoded, encoding: .utf8)!)
    exit(1)
}
