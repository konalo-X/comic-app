import Foundation

@MainActor
final class JobQueue: ObservableObject {
    static let shared = JobQueue()
    
    @Published private(set) var jobs: [Job] = []
    
    private var runningTask: Task<Void, Never>?
    private var refreshTimer: Timer?
    private let maxConcurrent = 2
    private var runningCount = 0
    private var started = false
    
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
    
    @discardableResult
    func add(type: JobType, payload: [String: String], priority: Int = 0) -> String {
        let job = Job(type: type, payload: payload, priority: priority)
        jobs.insert(job, at: 0)
        scheduleProcessing()
        return job.id
    }
    
    func updateJob(id: String, modify: (inout Job) -> Void) {
        guard let idx = jobs.firstIndex(where: { $0.id == id }) else { return }
        modify(&jobs[idx])
    }
    
    func cancel(jobId: String) {
        updateJob(id: jobId) { if $0.status == .pending || $0.status == .running { $0.status = .cancelled } }
    }
    
    func remove(jobId: String) {
        jobs.removeAll { $0.id == jobId }
    }
    
    func clearCompleted() {
        jobs.removeAll { $0.status == .completed || $0.status == .failed || $0.status == .cancelled }
    }
    
    func retry(jobId: String) {
        updateJob(id: jobId) {
            if $0.status == .failed || $0.status == .cancelled {
                $0.status = .pending
                $0.retryCount = 0
                $0.error = nil
                $0.progress = 0
            }
        }
        scheduleProcessing()
    }
    
    func retryAll() {
        for i in jobs.indices {
            if jobs[i].status == .failed || jobs[i].status == .cancelled {
                jobs[i].status = .pending
                jobs[i].retryCount = 0
                jobs[i].error = nil
                jobs[i].progress = 0
            }
        }
        scheduleProcessing()
    }
    
    func cancelAll() {
        for i in jobs.indices {
            if jobs[i].status == .pending || jobs[i].status == .running {
                jobs[i].status = .cancelled
            }
        }
    }
    
    func list(status: JobStatus?, limit: Int = 500) -> [Job] {
        let filtered = status == nil ? jobs : jobs.filter { $0.status == status }
        if filtered.count <= limit { return filtered }
        return Array(filtered.prefix(limit))
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
        return toRemove.count
    }
    
    func clear() { clearCompleted() }
    
    func start() {
        guard !started else { return }
        started = true
        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: NSNotification.Name("jobRefreshTick"), object: nil)
                Task { @MainActor in
                    self?.processQueue()
                }
            }
        }
        RunLoop.main.add(refreshTimer!, forMode: .common)
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
    
    private func processQueue() {
        while runningCount < maxConcurrent {
            guard jobs.contains(where: { $0.status == .pending }) else {
                return
            }
            var sortedPending: [(Int, Job)] = []
            for (idx, job) in jobs.enumerated() where job.status == .pending {
                sortedPending.append((idx, job))
            }
            sortedPending.sort { (a: (Int, Job), b: (Int, Job)) -> Bool in
                if a.1.priority != b.1.priority { return a.1.priority > b.1.priority }
                return a.1.createdAt < b.1.createdAt
            }
            guard let pick = sortedPending.first else { return }
            let pendingIdxFinal = pick.0
            var job = jobs[pendingIdxFinal]
            job.status = .running
            jobs[pendingIdxFinal] = job
            runningCount += 1
            
            let capturedId = job.id
            Task.detached(priority: .userInitiated) { [weak self] in
                await self?.executeJob(id: capturedId)
                Task { @MainActor in
                    guard let self else { return }
                    self.runningCount = max(0, self.runningCount - 1)
                    self.processQueue()
                }
            }
        }
    }
    
    private func executeJob(id: String) async {
        let currentJob: Job? = await MainActor.run {
            self.jobs.first { $0.id == id }
        }
        guard let job = currentJob else { return }
        
        var shouldRetry = false
        do {
            switch job.type {
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
                await MainActor.run {
                    self.updateJob(id: id) { $0.message = "导入功能待实现"; $0.progress = 1.0 }
                }
            case .export:
                try await ExportService.shared.handleExportJob(job: job, queue: self)
            }
            await MainActor.run {
                self.updateJob(id: id) { $0.status = .completed; $0.progress = 1.0 }
            }
        } catch {
            await MainActor.run {
                if let j = self.jobs.first(where: { $0.id == id }), j.status == .cancelled {
                    self.updateJob(id: id) { $0.status = .cancelled; $0.error = error.localizedDescription }
                    return
                }
                self.updateJob(id: id) { j in
                    j.error = error.localizedDescription
                    if j.retryCount + 1 < j.maxRetries {
                        j.retryCount += 1
                        j.status = .pending
                        shouldRetry = true
                    } else {
                        j.status = .failed
                    }
                }
            }
            if shouldRetry {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                await MainActor.run { self.scheduleProcessing() }
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
                j.progress = progress
                if let message { j.message = message }
            }
        }
    }
}