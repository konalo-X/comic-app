import SwiftUI

struct ReadingHistoryView: View {
    @EnvironmentObject var app: AppStore
    @State private var histories: [ReadingProgress] = []
    @State private var searchText = ""
    @State private var onlyFavorited = false
    
    var filtered: [ReadingProgress] {
        histories.filter { h in
            if onlyFavorited {
                guard let c = app.comics.first(where: { $0.id == h.comicId }) else { return false }
                if c.favorited == 0 { return false }
            }
            if !searchText.isEmpty {
                guard let c = app.comics.first(where: { $0.id == h.comicId }) else { return false }
                return c.title.localizedCaseInsensitiveContains(searchText)
            }
            return true
        }
    }
    
    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if filtered.isEmpty {
                ContentUnavailableView("暂无阅读记录", systemImage: "clock.arrow.circlepath",
                    description: Text("开始阅读漫画后，会在这里显示你的阅读历史"))
            } else {
                List {
                    ForEach(filtered) { h in
                        historyRow(h)
                            .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    }
                }
                .listStyle(.inset)
            }
        }
        .onAppear(perform: load)
        .onChange(of: app.comics) { _, _ in load() }
        .navigationTitle("阅读历史")
    }
    
    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.title2).foregroundStyle(.secondary)
            VStack(alignment: .leading) {
                Text("阅读历史").font(.title3.weight(.semibold))
                Text("共 \(histories.count) 条记录").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Toggle("仅收藏", isOn: $onlyFavorited).toggleStyle(.switch).controlSize(.mini)
            Button(role: .destructive) {
                if let db = try? ReadingRepository.shared {
                    try? db.clearAllHistory()
                    histories.removeAll()
                }
            } label: { Image(systemName: "trash") }
            .help("清空全部历史")
        }
        .padding(16)
    }
    
    private func historyRow(_ h: ReadingProgress) -> some View {
        let comic = app.comics.first(where: { $0.id == h.comicId })
        return HStack(spacing: 12) {
            AsyncImage(url: URL(string: comic?.cover ?? "")) { phase in
                if let img = phase.image { img.resizable().aspectRatio(contentMode: .fill) }
                else { RoundedRectangle(cornerRadius: 6).fill(.gray.opacity(0.2)) }
            }
            .frame(width: 56, height: 74).clipped().cornerRadius(6)
            
            VStack(alignment: .leading, spacing: 4) {
                Text(comic?.title ?? "未知漫画").font(.body.weight(.semibold)).lineLimit(1)
                Text("第 \(h.chapterIndex + 1) 话 · 第 \(h.pageIndex + 1) 页").font(.caption).foregroundStyle(.secondary)
                ProgressView(value: min(1.0, Double(h.pageIndex + 1) / Double(max(1, h.totalPages ?? 0)))).frame(height: 3)
                let d = Date(timeIntervalSince1970: Double(h.updatedAt) / 1000)
                Text(d.formatted(.relative(presentation: .named))).font(.caption2).foregroundStyle(.tertiary)
            }
            Spacer()
            Button("继续阅读") {
                if let c = comic {
                    NotificationCenter.default.post(name: .startReading, object: c)
                }
            }
            .buttonStyle(.borderedProminent).controlSize(.small)
        }
        .contentShape(Rectangle())
        .onTapGesture(count: 2) {
            if let c = comic {
                NotificationCenter.default.post(name: .startReading, object: c)
            }
        }
    }
    
    private func load() {
        guard let db = try? ReadingRepository.shared else { return }
        histories = (try? db.allHistory()) ?? []
    }
}