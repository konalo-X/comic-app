import SwiftUI

struct DownloadPageView: View {
    @State private var selectedTab: JobStatus? = nil
    @State private var selection: Set<String> = []
    @State private var tick: Int = 0
    
    var body: some View {
        VStack(spacing: 0) {
            topBar
            Divider()
            statsBar.padding(.horizontal, 16).padding(.vertical, 10)
            Divider()
            if filteredJobs.isEmpty && selectedTab != .failed {
                emptyState
            } else {
                List(selection: $selection) {
                    ForEach(filteredJobs) { job in
                        JobRow(job: job)
                            .tag(job.id)
                            .contextMenu {
                                let isPendingOrRunning = job.status == .pending || job.status == .running
                                let isFailed = job.status == .failed
                                if isPendingOrRunning {
                                    Button("取消") { JobQueue.shared.cancel(jobId: job.id) }
                                }
                                if isFailed {
                                    Button("重试") { JobQueue.shared.retry(jobId: job.id) }
                                }
                                Button("移除") { JobQueue.shared.remove(jobId: job.id) }
                            }
                    }
                }
                .listStyle(.inset(alternatesRowBackgrounds: true))
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name("jobRefreshTick"))) { _ in
            tick += 1
        }
    }
    
    private var topBar: some View {
        HStack(spacing: 10) {
            Picker("", selection: $selectedTab) {
                Text("全部").tag(Optional<JobStatus>.none)
                Text("等待中").tag(Optional<JobStatus>(.pending))
                Text("进行中").tag(Optional<JobStatus>(.running))
                Text("已完成").tag(Optional<JobStatus>(.completed))
                Text("失败").tag(Optional<JobStatus>(.failed))
                Text("已取消").tag(Optional<JobStatus>(.cancelled))
            }
            .pickerStyle(.segmented)
            .fixedSize()
            
            Spacer()
            
            Menu {
                Button("重试全部失败") { JobQueue.shared.retryAll() }
                Button("清理重复下载任务") { _ = JobQueue.shared.cleanupDuplicateDownloads() }
                Button("清理重复同步任务") { _ = JobQueue.shared.cleanupDuplicateSyncs() }
                Divider()
                Button("清理已完成/已取消", role: .destructive) { JobQueue.shared.clear() }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            
            Button(action: refresh) {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
    
    private var statsBar: some View {
        let stats = JobQueue.shared.stats
        return HStack(spacing: 10) {
            statChip(icon: "clock", label: "等待", value: stats.pending, color: .orange)
            statChip(icon: "bolt.fill", label: "进行中", value: stats.running, color: .blue)
            statChip(icon: "checkmark.circle.fill", label: "完成", value: stats.completed, color: .green)
            statChip(icon: "xmark.octagon.fill", label: "失败", value: stats.failed, color: .red)
            statChip(icon: "slash.circle.fill", label: "取消", value: stats.cancelled, color: .gray)
            Spacer()
        }
    }
    
    private func statChip(icon: String, label: String, value: Int, color: Color) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon).foregroundStyle(color)
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text("\(value)")
                .font(.caption).bold()
                .foregroundStyle(color)
                .monospacedDigit()
                .padding(.horizontal, 6).padding(.vertical, 1)
                .background(Capsule().fill(color.opacity(0.1)))
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.gray.opacity(0.06)))
    }
    
    private var filteredJobs: [Job] {
        let list = JobQueue.shared.list(status: selectedTab, limit: 500)
        return list
    }
    
    private func refresh() {
        NotificationCenter.default.post(name: NSNotification.Name("jobRefreshTick"), object: nil)
    }
    
    private var emptyState: some View {
        VStack(spacing: 18) {
            Image(systemName: "square.and.arrow.down.on.square")
                .font(.system(size: 68))
                .foregroundStyle(.secondary.opacity(0.5))
            VStack(spacing: 6) {
                Text("暂无\(selectedTab != nil ? tabName(selectedTab!) : "")任务")
                    .font(.title2).bold()
                Text("在书架中选择漫画并点击下载，章节会自动出现在这里")
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    
    private func tabName(_ s: JobStatus) -> String {
        switch s {
        case .pending: return "等待中"
        case .running: return "进行中"
        case .completed: return "已完成"
        case .failed: return "失败"
        case .cancelled: return "已取消"
        case .paused: return "已暂停"
        }
    }
}

struct JobRow: View {
    let job: Job
    @State private var tick: Int = 0
    
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                typeIcon
                    .frame(width: 24, height: 24)
                    .background(Circle().fill(typeColor.opacity(0.15)))
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text(titleText)
                            .font(.system(size: 14, weight: .medium))
                            .lineLimit(1)
                        statusBadge
                        Text(timeAgo)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
            }
            
            if job.status == .running || job.status == .pending {
                HStack(spacing: 10) {
                    ProgressView(value: job.progress)
                        .progressViewStyle(.linear)
                        .tint(job.status == .running ? .blue : .orange)
                    Text(String(format: "%.0f%%", job.progress * 100))
                        .font(.caption2).monospacedDigit()
                        .foregroundStyle(.secondary)
                        .frame(width: 40, alignment: .trailing)
                }
                if let msg = job.message {
                    Text(msg)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else if job.status == .failed, let err = job.error {
                Text(err)
                    .font(.caption2)
                    .foregroundStyle(.red)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.vertical, 6)
        .onReceive(NotificationCenter.default.publisher(for: NSNotification.Name("jobRefreshTick"))) { _ in
            tick += 1
        }
    }
    
    private var typeIcon: some View {
        switch job.type {
        case .sync: return Image(systemName: "arrow.triangle.2.circlepath").foregroundStyle(.blue)
        case .download: return Image(systemName: "square.and.arrow.down").foregroundStyle(.purple)
        case .enrich: return Image(systemName: "sparkles").foregroundStyle(.yellow)
        case .repair: return Image(systemName: "wrench.and.screwdriver").foregroundStyle(.orange)
        case .crawl: return Image(systemName: "ladybug").foregroundStyle(.green)
        case .importComic: return Image(systemName: "square.and.arrow.up").foregroundStyle(.teal)
        case .export: return Image(systemName: "square.and.arrow.up.on.square").foregroundStyle(.indigo)
        }
    }
    
    private var typeColor: Color {
        switch job.type {
        case .sync: return .blue
        case .download: return .purple
        case .enrich: return .yellow
        case .repair: return .orange
        case .crawl: return .green
        case .importComic: return .teal
        case .export: return .indigo
        }
    }
    
    private var statusBadge: some View {
        let text: String
        let color: Color
        switch job.status {
        case .pending: text = "等待"; color = .orange
        case .running: text = "运行"; color = .blue
        case .completed: text = "完成"; color = .green
        case .failed: text = "失败"; color = .red
        case .cancelled: text = "取消"; color = .gray
        case .paused: text = "暂停"; color = .secondary
        }
        return Text(text)
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Capsule().fill(color.opacity(0.15)))
    }
    
    private var titleText: String {
        switch job.type {
        case .sync: return job.payload["sourceUrl"].flatMap { u in
            URL(string: u)?.lastPathComponent.removingPercentEncoding
        } ?? job.payload["comicTitle"] ?? "同步漫画信息"
        case .download:
            let t = job.payload["comicTitle"] ?? ""
            let n = job.payload["chapterName"] ?? ((job.payload["chapterIndex"].flatMap(Int.init)).map { "第\($0 + 1)话" } ?? "")
            return "下载：\(t) \(n)"
        case .enrich: return "补齐章节名称/图片数"
        case .repair: return "修复下载记录"
        case .crawl: return "抓取漫画列表"
        case .importComic: return "导入：\(job.payload["title"] ?? "本地漫画")"
        case .export:
            let fmt = job.payload["format"] ?? "cbz"
            return "导出 \(fmt.uppercased())：\(job.payload["comicTitle"] ?? "漫画")"
        }
    }
    
    private var subtitle: String {
        var parts: [String] = []
        switch job.type {
        case .download:
            if let c = job.payload["comicTitle"] { parts.append(c) }
        default:
            break
        }
        if job.retryCount > 0 { parts.append("重试 \(job.retryCount)/\(job.maxRetries)") }
        parts.append("ID: \(job.id.prefix(8))")
        return parts.joined(separator: " · ")
    }
    
    private var timeAgo: String {
        let now = Date().timeIntervalSince1970 * 1000
        let delta = Double(now) - Double(job.updatedAt)
        let s = Int(delta / 1000)
        if s < 60 { return "\(s)秒前" }
        if s < 3600 { return "\(s / 60)分钟前" }
        if s < 86400 { return "\(s / 3600)小时前" }
        return "\(s / 86400)天前"
    }
}