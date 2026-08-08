import Foundation

@MainActor
final class JobQueue: ObservableObject {
    static let shared = JobQueue()
    
    @Published private(set) var jobs: [Job] = []
    
    private var runningTask: Task<Void, Never>?
    private var heartbeatTimer: Timer?
    private var flushTimer: Timer?
    
    private let maxConcurrentDownload = 4
    private let maxConcurrentSync = 2
    private let maxConcurrentEnrich = 1
    
    private var started = false
    private var dirtyIds: Set<String> = []
    private var lastFlushMs: Int64 = 0
    
    private init() {}
    
    var stats: (pending: Int, running: Int, completed: Int, failed: Int, cancelled: Int) {
        var pending = 0, running = 0, completed = 0, failed = 0, cancelled = 0
        for j in jobs {
            switch j.status {
            case .pending: pending += 1
            case .running: running += 1
            case .completed: completed += 1
            case .failed: failed += 1
            case .cancelled: cancelled += 1
            case .paused: pending += 1
            }
        }
        return (pending, running, completed, failed, cancelled)
    }
    
    func initialize() throws {
        let recoveredZombie = try JobQueueRepository.shared.resetRunningToPending()
        if recoveredZombie > 0 { NSLog("[JobQueue] 崩溃恢复：重置 \(recoveredZombie) 个僵尸任务为waiting") }
        let active = try JobQueueRepository.shared.loadActive()
        self.jobs = active
        NSLog("[JobQueue] 从DB加载活跃任务数=\(active.count)")
    }
    
    @discardableResult
    func add(type: JobType, payload: [String: String], priority: Int = 2, delayMs: Int = 0, timeoutMs: Int? = nil, mutexKey: String? = nil, source: String = "auto") -> String {
        var job = Job(type: type, status: .pending)
        job.payload = payload
        job.priority = min(3, max(0, priority))
        job.delayMs = delayMs
        job.timeoutMs = timeoutMs
        job.mutexKey = mutexKey
        job.source = source
        jobs.insert(job, at: 0)
        persistDirty(jobId: job.id)
        scheduleProcessing()
        return job.id
    }
    
    func updateJob(id: String, modify: (inout Job) -> Void) {
        guard let idx = jobs.firstIndex(where: { $0.id == id }) else { return }
        modify(&jobs[idx])
        jobs[idx].updatedAt = Int64(Date().timeIntervalSince1970 * 1000)
        persistDirty(jobId: id)
    }
    
    func cancel(jobId: String) {
        updateJob(id: jobId) {
            if $0.status == .pending || $0.status == .running {
                $0.status = .cancelled
                $0.completedAt = Int64(Date().timeIntervalSince1970 * 1000)
            }
        }
        flushDirty()
    }
    
    func remove(jobId: String) {
        jobs.removeAll { $0.id == jobId }
        try? JobQueueRepository.shared.delete(id: jobId)
        dirtyIds.remove(jobId)
    }
    
    func clearCompleted() {
        let before = jobs.count
        jobs.removeAll { $0.status == .completed || $0.status == .failed || $0.status == .cancelled }
        try? JobQueueRepository.shared.deleteCompleted()
        NSLog("[JobQueue] 清理已完成，删除=\(before - jobs.count)")
    }
    
    func retry(jobId: String) {
        updateJob(id: jobId) {
            if $0.status == .failed || $0.status == .cancelled {
                $0.status = .pending
                $0.retryCount = 0
                $0.error = nil
                $0.progress = 0
                $0.progressCurrent = 0
                $0.startedAt = 0
                $0.completedAt = 0
            }
        }
        flushDirty()
        scheduleProcessing()
    }
    
    func retryAll() {
        for i in jobs.indices {
            if jobs[i].status == .failed || jobs[i].status == .cancelled {
                jobs[i].status = .pending
                jobs[i].retryCount = 0
                jobs[i].error = nil
                jobs[i].progress = 0
                jobs[i].progressCurrent = 0
                jobs[i].startedAt = 0
                jobs[i].completedAt = 0
                dirtyIds.insert(jobs[i].id)
            }
        }
        flushDirty()
        scheduleProcessing()
    }
    
    func cancelAll() {
        for i in jobs.indices {
            if jobs[i].status == .pending || jobs[i].status == .running {
                jobs[i].status = .cancelled
                jobs[i].completedAt = Int64(Date().timeIntervalSince1970 * 1000)
                dirtyIds.insert(jobs[i].id)
            }
        }
        flushDirty()
    }
    
    func list(status: JobStatus?, limit: Int = 500) -> [Job] {
        let filtered = status == nil ? jobs : jobs.filter { $0.status == status }
        if filtered.count <= limit { return filtered }
        return Array(filtered.prefix(limit))
    }
    
    func runningDownloads(forComicId comicId: String) -> [Job] {
        return jobs.filter { $0.type == .download && ($0.status == .pending || $0.status == .running) && $0.payload["comicId"] == comicId }
    }
    
    @discardableResult
    func cleanupDuplicateDownloads() -> Int {
        var seen = Set<String>()
        var toRemove = Set<String>()
        for job in jobs where job.type == .download && (job.status == .pending || job.status == .running) {
            let key = (job.payload["chapterId"] ?? "") + "-" + (job.payload["comicId"] ?? "")
            if key.isEmpty { continue }
            if seen.contains(key) { toRemove.insert(job.id) }
            else { seen.insert(key) }
        }
        jobs.removeAll { toRemove.contains($0.id) }
        for id in toRemove { try? JobQueueRepository.shared.delete(id: id) }
        return toRemove.count
    }
    
    @discardableResult
    func cleanupDuplicateSyncs() -> Int {
        var seen = Set<String>()
        var toRemove = Set<String>()
        for job in jobs where job.type == .sync && (job.status == .pending || job.status == .running) {
            guard let key = job.payload["sourceUrl"], !key.isEmpty else { continue }
            if seen.contains(key) { toRemove.insert(job.id) }
            else { seen.insert(key) }
        }
        jobs.removeAll { toRemove.contains($0.id) }
        for id in toRemove { try? JobQueueRepository.shared.delete(id: id) }
        return toRemove.count
    }
    
    func clear() { clearCompleted() }
    
    func start() {
        guard !started else { return }
        started = true
        heartbeatTimer?.invalidate()
        flushTimer?.invalidate()
        
        heartbeatTimer = Timer.scheduledTimer(withTimeInterval: 45.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.heartbeatTick()
            }
        }
        RunLoop.main.add(heartbeatTimer!, forMode: .common)
        
        flushTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.flushDirty()
            }
        }
        RunLoop.main.add(flushTimer!, forMode: .common)
        
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 500_000_000)
            self.heartbeatTick()
        }
        processQueue()
    }
    
    func startupEnrichIfNeeded() async throws {
        let all = try ComicRepository.shared.list(page: 1, pageSize: 100, favorited: nil, category: nil, search: nil, sortBy: "updatedAt", sortDesc: true)
        let needEnrich = all.items.contains { c in
            if c.chapters.isEmpty { return false }
            return c.chapters.contains { $0.imageCount == 0 }
        } || all.items.isEmpty
        if needEnrich && !all.items.isEmpty {
            self.add(type: .enrich, payload: [:], priority: 1)
        }
    }
    
    private func scheduleProcessing() {
        Task { @MainActor in
            self.processQueue()
        }
    }
    
    private func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
    
    private func persistDirty(jobId: String) {
        dirtyIds.insert(jobId)
        if dirtyIds.count > 20 {
            flushDirty()
        }
    }
    
    private func flushDirty() {
        let currentTime = nowMs()
        if dirtyIds.isEmpty { return }
        let capturedIds = dirtyIds
        dirtyIds.removeAll()
        let captured = jobs
        Task.detached(priority: .background) {
            for job in captured where capturedIds.contains(job.id) {
                try? JobQueueRepository.shared.upsert(job: job)
            }
        }
        lastFlushMs = currentTime
    }
    
    private func heartbeatTick() {
        let now = nowMs()
        Task.detached(priority: .utility) {
            do {
                let zombies = try JobQueueRepository.shared.findZombies(timeoutMs: 15 * 60 * 1000)
                if !zombies.isEmpty {
                    await MainActor.run {
                        for zid in zombies {
                            if let idx = self.jobs.firstIndex(where: { $0.id == zid }) {
                                let job = self.jobs[idx]
                                if job.status == .running {
                                    if job.retryCount + 1 < job.maxRetries {
                                        self.jobs[idx].status = .pending
                                        self.jobs[idx].retryCount += 1
                                        self.jobs[idx].error = "僵尸任务自动恢复 (timeout)"
                                        NSLog("[JobQueue] 僵尸任务恢复 \(job.id) 重试\(self.jobs[idx].retryCount)/\(job.maxRetries)")
                                    } else {
                                        self.jobs[idx].status = .failed
                                        self.jobs[idx].error = "任务超时15分钟且达到最大重试次数"
                                        NSLog("[JobQueue] 僵尸任务超时失败 \(job.id)")
                                    }
                                    self.dirtyIds.insert(zid)
                                }
                            }
                        }
                        self.flushDirty()
                        self.scheduleProcessing()
                    }
                }
                let aging = try JobQueueRepository.shared.findAging(timeoutMs: 5 * 60 * 1000)
                if !aging.isEmpty {
                    await MainActor.run {
                        for (aid, curP) in aging {
                            if let idx = self.jobs.firstIndex(where: { $0.id == aid }) {
                                let newP = min(3, curP + 1)
                                if self.jobs[idx].priority != newP {
                                    self.jobs[idx].priority = newP
                                    self.jobs[idx].lastAgedAt = now
                                    self.dirtyIds.insert(aid)
                                }
                            }
                        }
                        self.flushDirty()
                    }
                }
                let _ = try? JobQueueRepository.shared.deleteCompleted(olderThanMs: 24 * 60 * 60 * 1000)
            } catch {}
        }
    }
    
    private func typeConcurrencyCount(type: JobType) -> (running: Int, max: Int) {
        var running = 0
        for j in jobs where j.status == .running && j.type == type { running += 1 }
        let max: Int
        switch type {
        case .download: max = maxConcurrentDownload
        case .sync: max = maxConcurrentSync
        case .enrich: max = maxConcurrentEnrich
        case .repair: max = 1
        case .crawl: max = 1
        case .importComic: max = 1
        case .export: max = 2
        }
        return (running, max)
    }
    
    private func processQueue() {
        let now = nowMs()
        while true {
            guard jobs.contains(where: { $0.status == .pending }) else { return }
            var sortedPending: [(Int, Job)] = []
            for (idx, job) in jobs.enumerated() where job.status == .pending {
                if job.delayMs > 0 && job.createdAt + Int64(job.delayMs) > now { continue }
                let tc = typeConcurrencyCount(type: job.type)
                if tc.running >= tc.max { continue }
                if let mk = job.mutexKey, !mk.isEmpty {
                    if jobs.contains(where: { $0.status == .running && $0.mutexKey == mk }) { continue }
                }
                sortedPending.append((idx, job))
            }
            sortedPending.sort { (a: (Int, Job), b: (Int, Job)) -> Bool in
                if a.1.priority != b.1.priority { return a.1.priority > b.1.priority }
                return a.1.createdAt < b.1.createdAt
            }
            guard let pick = sortedPending.first else { return }
            let pendingIdx = pick.0
            var job = jobs[pendingIdx]
            job.status = .running
            job.startedAt = now
            jobs[pendingIdx] = job
            persistDirty(jobId: job.id)
            
            let capturedId = job.id
            let hasTimeout = job.timeoutMs ?? 0 > 0
            let timeoutValue = job.timeoutMs ?? 0
            
            Task.detached(priority: .userInitiated) { [weak self] in
                var timeoutTask: Task<Void, Never>?
                if hasTimeout {
                    timeoutTask = Task.detached(priority: .background) {
                        try? await Task.sleep(nanoseconds: UInt64(max(1000, timeoutValue)) * 1_000_000)
                        Task { @MainActor in
                            guard let self, let idx = self.jobs.firstIndex(where: { $0.id == capturedId }) else { return }
                            if self.jobs[idx].status == .running {
                                NSLog("[JobQueue] 任务超时 \(capturedId)")
                                self.jobs[idx].error = "超时 (timeout)"
                                if self.jobs[idx].retryCount + 1 < self.jobs[idx].maxRetries {
                                    self.jobs[idx].status = .pending
                                    self.jobs[idx].retryCount += 1
                                } else {
                                    self.jobs[idx].status = .failed
                                }
                                self.persistDirty(jobId: capturedId)
                                self.scheduleProcessing()
                            }
                        }
                    }
                }
                await self?.executeJob(id: capturedId)
                timeoutTask?.cancel()
                Task { @MainActor in
                    self?.flushDirty()
                    self?.processQueue()
                }
            }
        }
    }
    
    private func classifyError(_ err: Error) -> (retryable: Bool, label: String) {
        let msg = err.localizedDescription.lowercased()
        let ns = err as NSError
        let code = ns.code
        let domain = ns.domain
        if domain == NSURLErrorDomain {
            switch code {
            case NSURLErrorTimedOut, NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost,
                 NSURLErrorNotConnectedToInternet, NSURLErrorDNSLookupFailed,
                 NSURLErrorSecureConnectionFailed, NSURLErrorCannotFindHost:
                return (true, "net:\(code)")
            default: break
            }
        }
        if msg.contains("too many requests") || msg.contains("rate limit") || code == 429 { return (true, "rate_limit") }
        if (code == 500 || code == 502 || code == 503 || code == 504) && domain == NSURLErrorDomain { return (true, "5xx:\(code)") }
        if msg.contains("被重置") || msg.contains("reset by peer") || msg.contains("connection reset") { return (true, "reset") }
        if msg.contains("403") || msg.contains("forbidden") { return (false, "403") }
        if msg.contains("404") || msg.contains("not found") { return (false, "404") }
        if msg.contains("取消") || msg.contains("cancelled") { return (false, "cancelled") }
        return (true, "other")
    }
    
    private func executeJob(id: String) async {
        let currentJob: Job? = await MainActor.run { self.jobs.first { $0.id == id } }
        guard var job = currentJob else { return }
        let capturedType = job.type
        
        do {
            switch capturedType {
            case .sync:
                try await SyncService.shared.syncComic(job: job, queue: self)
            case .download:
                try await DownloadService.shared.downloadChapter(job: job, queue: self)
            case .enrich:
                try await EnrichService.shared.enrich(job: job, queue: self)
            case .repair:
                try await RepairService.shared.repair(job: job, queue: self)
            case .crawl:
                try await CrawlService.shared.crawl(job: job, queue: self)
            case .importComic:
                try await ImportService.shared.handleImportJob(job: job, queue: self)
            case .export:
                try await ExportService.shared.handleExportJob(job: job, queue: self)
            }
            await MainActor.run {
                guard let idx = self.jobs.firstIndex(where: { $0.id == id }) else { return }
                self.jobs[idx].status = .completed
                self.jobs[idx].progress = 1.0
                self.jobs[idx].progressCurrent = max(self.jobs[idx].progressCurrent, self.jobs[idx].progressTotal > 0 ? self.jobs[idx].progressTotal : 1)
                self.jobs[idx].completedAt = self.nowMs()
                if self.jobs[idx].repeatIntervalMs > 0 {
                    var repeated = Job(type: capturedType, status: .pending)
                    repeated.payload = self.jobs[idx].payload
                    repeated.priority = self.jobs[idx].priority
                    repeated.delayMs = self.jobs[idx].repeatIntervalMs
                    repeated.repeatIntervalMs = self.jobs[idx].repeatIntervalMs
                    repeated.maxRetries = self.jobs[idx].maxRetries
                    repeated.timeoutMs = self.jobs[idx].timeoutMs
                    repeated.source = self.jobs[idx].source
                    repeated.mutexKey = self.jobs[idx].mutexKey
                    self.jobs.append(repeated)
                    self.persistDirty(jobId: repeated.id)
                }
                self.persistDirty(jobId: id)
            }
        } catch {
            await MainActor.run {
                guard let idx = self.jobs.firstIndex(where: { $0.id == id }) else { return }
                if self.jobs[idx].status == .cancelled {
                    self.jobs[idx].completedAt = self.nowMs()
                    self.persistDirty(jobId: id)
                    return
                }
                let (retryable, label) = self.classifyError(error)
                self.jobs[idx].error = error.localizedDescription
                Task.detached(priority: .background) {
                    JobQueueRepository.shared.incrementFailure(reason: label)
                }
                if retryable && self.jobs[idx].retryCount + 1 < self.jobs[idx].maxRetries {
                    self.jobs[idx].retryCount += 1
                    self.jobs[idx].status = .pending
                    let backoff = UInt64(min(30, 1 + self.jobs[idx].retryCount * 2)) * 1_000_000_000
                    self.persistDirty(jobId: id)
                    Task.detached(priority: .utility) {
                        try? await Task.sleep(nanoseconds: backoff)
                        Task { @MainActor in self.scheduleProcessing() }
                    }
                } else {
                    self.jobs[idx].status = .failed
                    self.jobs[idx].completedAt = self.nowMs()
                    self.persistDirty(jobId: id)
                }
            }
        }
    }
    
    func checkCancelled(jobId: String) async -> Bool {
        await MainActor.run {
            JobQueue.shared.jobs.first { $0.id == jobId }?.status == .cancelled
        }
    }
    
    nonisolated func reportProgress(jobId: String, progress: Double, message: String? = nil) {
        DispatchQueue.main.async {
            JobQueue.shared.updateJob(id: jobId) { j in
                let total = max(1, j.progressTotal)
                j.progress = progress
                j.progressCurrent = Int(progress * Double(total))
                if let message { j.message = message }
            }
        }
    }
    
    nonisolated func reportProgress(jobId: String, current: Int, total: Int, message: String? = nil) {
        DispatchQueue.main.async {
            JobQueue.shared.updateJob(id: jobId) { j in
                j.progressTotal = max(0, total)
                j.progressCurrent = max(0, min(total, current))
                if total > 0 { j.progress = Double(current) / Double(total) }
                if let message { j.message = message }
            }
        }
    }
    
}