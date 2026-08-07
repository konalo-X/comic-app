import SwiftUI

struct SearchView: View {
    @EnvironmentObject var store: AppStore
    @State private var keyword: String = ""
    @State private var results: [ComicSearchResult] = []
    @State private var isLoading = false
    @State private var errorMsg: String? = nil
    @State private var selectedSource: String? = nil
    
    var body: some View {
        VStack(spacing: 0) {
            searchBar.padding(.horizontal, 18).padding(.vertical, 12)
            Divider()
            
            ScrollView {
                if isLoading {
                    HStack { Spacer(); ProgressView("正在搜索...").controlSize(.large); Spacer() }
                        .padding(.top, 60)
                } else if let e = errorMsg {
                    VStack(spacing: 10) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 40)).foregroundStyle(.orange)
                        Text("搜索失败").bold()
                        Text(e).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal)
                        Button("重试", action: doSearch).buttonStyle(.borderedProminent)
                    }
                    .padding(.top, 60)
                } else if results.isEmpty && keyword.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "magnifyingglass.circle.fill")
                            .font(.system(size: 60)).foregroundStyle(.secondary.opacity(0.4))
                        Text("输入关键词开始搜索").font(.title2).foregroundStyle(.secondary)
                        Text("可搜索漫画名、作者、标签 · 多源聚合")
                            .font(.callout).foregroundStyle(.tertiary)
                        suggestions.padding(.top, 18)
                    }
                    .padding(.top, 80)
                } else if results.isEmpty {
                    VStack(spacing: 10) {
                        Image(systemName: "tray.and.zoom.out")
                            .font(.system(size: 54)).foregroundStyle(.secondary.opacity(0.4))
                        Text("没有找到「\(keyword)」相关结果").font(.title3).foregroundStyle(.secondary)
                        Text("试试更换关键词或调整搜索源").foregroundStyle(.tertiary)
                    }
                    .padding(.top, 60)
                } else {
                    LazyVGrid(
                        columns: [GridItem(.adaptive(minimum: 170), spacing: 18)],
                        spacing: 18
                    ) {
                        ForEach(results) { r in
                            ResultCard(result: r) { add in
                                if add { store.addSync(sourceUrl: r.sourceUrl, priority: 7) }
                            }
                            .contextMenu {
                                Button("添加到书架") { store.addSync(sourceUrl: r.sourceUrl, priority: 7) }
                                Button("在浏览器打开") {
                                    if let u = URL(string: r.sourceUrl) { NSWorkspace.shared.open(u) }
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 20).padding(.vertical, 18)
                }
            }
        }
    }
    
    private var searchBar: some View {
        HStack(spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("搜索漫画名 / 作者 / 标签", text: $keyword, onCommit: doSearch)
                    .textFieldStyle(.plain)
                    .onSubmit(doSearch)
                if !keyword.isEmpty {
                    Button(action: { keyword = ""; results = [] }) {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color.gray.opacity(0.08)))
            
            Picker("", selection: $selectedSource) {
                Text("全部源").tag(Optional<String>.none)
                ForEach(SourceRegistry.shared.listInfos(), id: \.id) { s in
                    Text(s.name).tag(Optional<String>(s.id))
                }
            }
            .fixedSize()
            
            Button(action: doSearch) {
                Label("搜索", systemImage: "magnifyingglass")
                    .labelStyle(.titleAndIcon)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.accentColor))
                    .foregroundStyle(.white)
            }
            .buttonStyle(.plain)
            .disabled(keyword.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isLoading)
            
            Button(action: { results = [] }) {
                Image(systemName: "xmark")
                    .frame(width: 32, height: 32)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.gray.opacity(0.08)))
            }
            .buttonStyle(.plain)
        }
    }
    
    private var suggestions: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("试试这些").font(.headline)
            FlowLayout(spacing: 8) {
                ForEach(["火影忍者", "海贼王", "鬼灭之刃", "咒术回战", "间谍过家家", "葬送的芙莉莲", "我的英雄学院", "电锯人"], id: \.self) { s in
                    Button(s) {
                        keyword = s
                        doSearch()
                    }
                    .buttonStyle(.bordered)
                }
            }
        }
        .frame(maxWidth: 520)
    }
    
    private func doSearch() {
        let kw = keyword.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !kw.isEmpty else { return }
        isLoading = true
        errorMsg = nil
        Task {
            do {
                let r = try await SourceRegistry.shared.search(query: kw, page: 1, sourceId: selectedSource)
                await MainActor.run {
                    self.results = r
                    self.isLoading = false
                }
            } catch {
                await MainActor.run {
                    self.errorMsg = error.localizedDescription
                    self.isLoading = false
                }
            }
        }
    }
}

private struct ResultCard: View {
    let result: ComicSearchResult
    let onAction: (Bool) -> Void
    @State private var cover: NSImage? = nil
    @State private var failed = false
    @State private var added = false
    
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack(alignment: .bottomTrailing) {
                Group {
                    if let c = cover {
                        Image(nsImage: c).resizable().scaledToFill()
                    } else if failed {
                        Rectangle().fill(
                            LinearGradient(colors: [.blue.opacity(0.35), .purple.opacity(0.35)],
                                          startPoint: .topLeading, endPoint: .bottomTrailing)
                        )
                        .overlay {
                            Text(result.title.prefix(6))
                                .font(.title3).bold().foregroundStyle(.white)
                                .shadow(color: .black.opacity(0.3), radius: 2)
                        }
                    } else {
                        Rectangle().fill(Color.gray.opacity(0.12))
                            .overlay { ProgressView().controlSize(.small) }
                    }
                }
                .frame(width: 160, height: 220).clipped().cornerRadius(10)
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.gray.opacity(0.15)))
                .shadow(color: .black.opacity(0.08), radius: 4, y: 2)
                
                Button(action: { onAction(true); added = true }) {
                    Image(systemName: added ? "checkmark.circle.fill" : "plus.circle.fill")
                        .foregroundStyle(added ? Color.green : .accentColor)
                        .frame(width: 28, height: 28)
                        .background(Circle().fill(.ultraThinMaterial))
                }
                .buttonStyle(.plain)
                .padding(8)
            }
            
            Text(result.title)
                .font(.system(size: 13, weight: .medium))
                .lineLimit(2)
                .frame(height: 34, alignment: .topLeading)
                .frame(maxWidth: .infinity, alignment: .leading)
            
            HStack(spacing: 6) {
                if let a = result.author, !a.isEmpty {
                    Text(a).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                if let c = result.category, !c.isEmpty {
                    Text(c).font(.system(size: 10)).foregroundStyle(.secondary)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Capsule().fill(Color.gray.opacity(0.12)))
                }
            }
            if let l = result.lastChapter, !l.isEmpty {
                Text(l)
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(width: 160)
        .contentShape(Rectangle())
        .onAppear(perform: loadCover)
    }
    
    private func loadCover() {
        guard let u = result.cover, let url = URL(string: u) else { failed = true; return }
        Task.detached {
            do {
                let d = try await SourceRegistry.shared.fetchImage(imageUrl: u, referer: result.sourceUrl)
                if let img = NSImage(data: d) {
                    await MainActor.run { self.cover = img }
                } else { await MainActor.run { self.failed = true } }
            } catch {
                await MainActor.run { self.failed = true }
            }
        }
        _ = url
    }
}