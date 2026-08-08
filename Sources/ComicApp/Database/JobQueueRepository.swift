import Foundation
import SQLite

final class JobQueueRepository: @unchecked Sendable {
    static let shared = JobQueueRepository()
    private let dbLock = NSLock()
    private init() {}
    
    private let jId = Expression<String>("id")
    private let jType = Expression<String>("type")
    private let jPriority = Expression<Int>("priority")
    private let jStatus = Expression<String>("status")
    private let jPayload = Expression<String>("payload")
    private let jResult = Expression<String?>("result")
    private let jError = Expression<String?>("error")
    private let jProgressCol = Expression<String?>("progress")
    private let jProgressTotal = Expression<Int>("progress_total")
    private let jProgressCurrent = Expression<Int>("progress_current")
    private let jRetryCount = Expression<Int>("retry_count")
    private let jMaxRetries = Expression<Int>("max_retries")
    private let jTimeout = Expression<Int?>("timeout")
    private let jDelay = Expression<Int>("delay")
    private let jRepeatInterval = Expression<Int>("repeat_interval")
    private let jLastProgressAt = Expression<Int64?>("last_progress_at")
    private let jAutoRetryCount = Expression<Int>("auto_retry_count")
    private let jLastAgedAt = Expression<Int64?>("last_aged_at")
    private let jSource = Expression<String>("source")
    private let jMutexKey = Expression<String?>("mutex_key")
    private let jCreatedAt = Expression<Int64>("created_at")
    private let jUpdatedAt = Expression<Int64>("updated_at")
    private let jStartedAt = Expression<Int64?>("started_at")
    private let jCompletedAt = Expression<Int64?>("completed_at")
    
    private func jobsTable() -> Table { return Table("job_queue") }
    
    private func now() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
    
    private func decodePayload(_ str: String) -> [String: String] {
        guard let data = str.data(using: .utf8),
              let dict = try? JSONDecoder().decode([String: String].self, from: data) else { return [:] }
        return dict
    }
    
    private func encodePayload(_ payload: [String: String]) -> String {
        guard let data = try? JSONEncoder().encode(payload),
              let s = String(data: data, encoding: .utf8) else { return "{}" }
        return s
    }
    
    private func rowToJob(_ row: Row) -> Job {
        let typeRaw = row[jType]
        let type = JobType(rawValue: typeRaw) ?? .sync
        let statusRaw = row[jStatus]
        let status: JobStatus
        switch statusRaw {
        case "waiting", "pending": status = .pending
        case "active", "running": status = .running
        case "completed": status = .completed
        case "failed": status = .failed
        case "cancelled": status = .cancelled
        case "paused": status = .paused
        default: status = .pending
        }
        var j = Job(id: row[jId], type: type, status: status)
        j.payload = decodePayload(row[jPayload])
        j.priority = row[jPriority]
        j.progress = Double(row[jProgressCurrent]) / max(1, Double(row[jProgressTotal]))
        if j.progress.isNaN || j.progress.isInfinite { j.progress = 0 }
        j.progressCurrent = row[jProgressCurrent]
        j.progressTotal = row[jProgressTotal]
        j.message = row[jProgressCol]
        j.error = row[jError]
        j.retryCount = row[jRetryCount]
        j.maxRetries = row[jMaxRetries]
        j.timeoutMs = row[jTimeout]
        j.delayMs = row[jDelay]
        j.repeatIntervalMs = row[jRepeatInterval]
        j.source = row[jSource]
        j.mutexKey = row[jMutexKey]
        j.createdAt = row[jCreatedAt]
        j.updatedAt = row[jUpdatedAt]
        j.startedAt = row[jStartedAt] ?? 0
        j.completedAt = row[jCompletedAt] ?? 0
        j.lastAgedAt = row[jLastAgedAt] ?? 0
        return j
    }
    
    func loadAll(limit: Int = 5000) throws -> [Job] {
        dbLock.lock()
        defer { dbLock.unlock() }
        let db = try DatabaseManager.shared.connection()
        let t = jobsTable().order(jPriority.desc, jCreatedAt.asc).limit(limit)
        return try db.prepare(t).map(rowToJob)
    }
    
    func loadActive(limit: Int = 2000) throws -> [Job] {
        dbLock.lock()
        defer { dbLock.unlock() }
        let db = try DatabaseManager.shared.connection()
        let notEnded: [String] = ["waiting", "pending", "active", "running", "paused"]
        let t = jobsTable()
            .filter(notEnded.contains(jStatus))
            .order(jPriority.desc, jCreatedAt.asc)
            .limit(limit)
        return try db.prepare(t).map(rowToJob)
    }
    
    func upsert(job: Job) throws {
        dbLock.lock()
        defer { dbLock.unlock() }
        let db = try DatabaseManager.shared.connection()
        let t = jobsTable()
        let statusString: String
        switch job.status {
        case .pending: statusString = "waiting"
        case .running: statusString = "active"
        case .completed: statusString = "completed"
        case .failed: statusString = "failed"
        case .cancelled: statusString = "cancelled"
        case .paused: statusString = "paused"
        }
        let payloadStr = encodePayload(job.payload)
        let time = now()
        let progressStr: String? = job.message
        let completedAt: Int64? = (job.completedAt > 0) ? job.completedAt : (job.status == .completed || job.status == .failed || job.status == .cancelled ? time : nil)
        let startedAt: Int64? = (job.startedAt > 0) ? job.startedAt : (job.status == .running ? time : nil)
        let timeout: Int? = job.timeoutMs
        let lastAgedAt: Int64? = job.lastAgedAt > 0 ? job.lastAgedAt : nil
        let lastProgressAt: Int64? = job.status == .running ? time : nil
        let setters: [Setter] = [
            jId <- job.id,
            jType <- job.type.rawValue,
            jPriority <- job.priority,
            jStatus <- statusString,
            jPayload <- payloadStr,
            jResult <- nil,
            jError <- job.error,
            jProgressCol <- progressStr,
            jProgressTotal <- max(0, job.progressTotal),
            jProgressCurrent <- max(0, job.progressCurrent),
            jRetryCount <- max(0, job.retryCount),
            jMaxRetries <- max(0, job.maxRetries),
            jTimeout <- timeout,
            jDelay <- max(0, job.delayMs),
            jRepeatInterval <- max(0, job.repeatIntervalMs),
            jLastProgressAt <- lastProgressAt,
            jAutoRetryCount <- 0,
            jLastAgedAt <- lastAgedAt,
            jSource <- job.source,
            jMutexKey <- job.mutexKey,
            jCreatedAt <- job.createdAt > 0 ? job.createdAt : time,
            jUpdatedAt <- time,
            jStartedAt <- startedAt,
            jCompletedAt <- completedAt
        ]
        do {
            try db.run(t.insert(or: .replace, setters))
        } catch {
            try db.run(t.insert(or: .replace,
                jId <- job.id,
                jType <- job.type.rawValue,
                jPriority <- job.priority,
                jStatus <- statusString,
                jPayload <- payloadStr,
                jError <- job.error,
                jProgressCol <- progressStr,
                jProgressTotal <- max(0, job.progressTotal),
                jProgressCurrent <- max(0, job.progressCurrent),
                jRetryCount <- max(0, job.retryCount),
                jMaxRetries <- max(0, job.maxRetries),
                jTimeout <- timeout,
                jDelay <- max(0, job.delayMs),
                jRepeatInterval <- max(0, job.repeatIntervalMs),
                jLastProgressAt <- lastProgressAt,
                jAutoRetryCount <- 0,
                jLastAgedAt <- lastAgedAt,
                jSource <- job.source,
                jMutexKey <- job.mutexKey,
                jCreatedAt <- job.createdAt > 0 ? job.createdAt : time,
                jUpdatedAt <- time,
                jStartedAt <- startedAt,
                jCompletedAt <- completedAt
            ))
        }
    }
    
    func delete(id: String) throws {
        dbLock.lock()
        defer { dbLock.unlock() }
        let db = try DatabaseManager.shared.connection()
        let t = jobsTable().filter(jId == id)
        try db.run(t.delete())
    }
    
    func deleteCompleted(olderThanMs: Int64 = 7 * 24 * 60 * 60 * 1000) throws -> Int {
        dbLock.lock()
        defer { dbLock.unlock() }
        let db = try DatabaseManager.shared.connection()
        let threshold = now() - olderThanMs
        let ended: [String] = ["completed", "failed", "cancelled"]
        var total = 0
        for s in ended {
            let query = jobsTable()
                .filter(jStatus == s)
                .filter((jCompletedAt ?? 0) < threshold || (jUpdatedAt < threshold && (jCompletedAt ?? 0) == 0))
            total += (try? db.run(query.delete())) ?? 0
        }
        return total
    }
    
    func findZombies(timeoutMs: Int64 = 15 * 60 * 1000) throws -> [String] {
        dbLock.lock()
        defer { dbLock.unlock() }
        let db = try DatabaseManager.shared.connection()
        let t = now()
        let rows = try db.prepare("SELECT id FROM job_queue WHERE status IN ('active','running') AND (last_progress_at IS NULL OR last_progress_at < ?)")
        let arr = try rows.run([t - timeoutMs])
        return arr.compactMap { $0[0] as? String }
    }
    
    func findAging(timeoutMs: Int64 = 5 * 60 * 1000) throws -> [(id: String, priority: Int)] {
        dbLock.lock()
        defer { dbLock.unlock() }
        let db = try DatabaseManager.shared.connection()
        let t = now()
        let rows = try db.prepare("SELECT id, priority FROM job_queue WHERE status IN ('waiting','pending') AND priority < 3 AND (last_aged_at IS NULL OR last_aged_at < ?)")
        let arr = try rows.run([t - timeoutMs])
        return arr.compactMap { row in
            guard let id = row[0] as? String, let p = row[1] as? Int else { return nil }
            return (id, p)
        }
    }
    
    func bumpPriority(id: String, to: Int) throws {
        dbLock.lock()
        defer { dbLock.unlock() }
        let db = try DatabaseManager.shared.connection()
        let t = now()
        let query = jobsTable().filter(jId == id)
        try db.run(query.update(jPriority <- to, jLastAgedAt <- t, jUpdatedAt <- t))
    }
    
    func resetRunningToPending() throws -> Int {
        dbLock.lock()
        defer { dbLock.unlock() }
        let db = try DatabaseManager.shared.connection()
        let query = jobsTable().filter(jStatus == "active" || jStatus == "running")
        let count = try? db.run(query.update(jStatus <- "waiting", jUpdatedAt <- now(), jStartedAt <- nil))
        return count ?? 0
    }
    
    func incrementFailure(reason: String) {
        let r = reason.count > 400 ? String(reason.prefix(400)) : reason
        dbLock.lock()
        defer { dbLock.unlock() }
        let table = Table("job_failure_stats")
        let fId = Expression<Int64>("id")
        let fReason = Expression<String>("reason")
        let fCount = Expression<Int>("count")
        let fLast = Expression<Int64>("last_update")
        guard let db = try? DatabaseManager.shared.connection() else { return }
        do {
            if let existing = try db.pluck(table.filter(fReason == r)) {
                let c = (try? existing.get(fCount)) ?? 0
                try db.run(table.filter(fId == existing[fId]).update(fCount <- c + 1, fLast <- now()))
            } else {
                try db.run(table.insert(or: .replace, fReason <- r, fCount <- 1, fLast <- now()))
            }
        } catch {}
    }
}