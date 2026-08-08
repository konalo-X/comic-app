import SwiftUI

struct CategoryMgrView: View {
    @EnvironmentObject var app: AppStore
    @State private var selectedCategory: String? = nil
    @State private var viewMode: ViewMode = .card
    
    enum ViewMode { case card, list }
    
    var categories: [(name: String, count: Int, color: Color)] {
        var map: [String: Int] = [:]
        for c in app.comics {
            if let t = c.category, !t.isEmpty {
                let parts = t.split(whereSeparator: { $0 == "," || $0 == " " || $0 == "、" }).map(String.init).filter { !$0.isEmpty }
                for p in parts { map[p, default: 0] += 1 }
            }
            if let t = c.tags, !t.isEmpty {
                let parts = t.split(whereSeparator: { $0 == "," || $0 == " " || $0 == "、" }).map(String.init).filter { !$0.isEmpty }
                for p in parts { map[p, default: 0] += 1 }
            }
        }
        let palette: [Color] = [.blue, .green, .orange, .purple, .pink, .mint, .indigo, .teal, .red, .yellow, .brown, .cyan]
        return map.sorted { $0.value > $1.value }.enumerated().map { (i, k) in
            (k.key, k.value, palette[i % palette.count])
        }
    }
    
    var filteredComics: [Comic] {
        guard let sel = selectedCategory else { return app.comics }
        return app.comics.filter { c in
            let hay = [c.category ?? "", c.tags ?? ""].joined(separator: " ")
            return hay.localizedCaseInsensitiveContains(sel)
        }
    }
    
    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    tagChip(name: "全部", count: app.comics.count, color: .gray, isAll: true)
                        .onTapGesture { selectedCategory = nil }
                    ForEach(categories, id: \.name) { cat in
                        tagChip(name: cat.name, count: cat.count, color: cat.color,
                                selected: selectedCategory == cat.name)
                            .onTapGesture { selectedCategory = (selectedCategory == cat.name) ? nil : cat.name }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            Divider()
            
            if filteredComics.isEmpty {
                ContentUnavailableView(selectedCategory == nil ? "书架空空" : "没有匹配的漫画",
                    systemImage: "tag.slash",
                    description: Text(selectedCategory == nil ? "去搜索或添加你感兴趣的漫画吧" : "当前分类下没有漫画"))
            } else {
                Group {
                    switch viewMode {
                    case .card: cardGrid
                    case .list: listView
                    }
                }
            }
        }
        .navigationTitle("分类与标签")
    }
    
    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: "tag.fill").font(.title2).foregroundStyle(.secondary)
            VStack(alignment: .leading) {
                Text("分类与标签").font(.title3.weight(.semibold))
                Text("\(categories.count) 个分类 · \(app.comics.count) 本漫画").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Picker("视图", selection: $viewMode) {
                Image(systemName: "square.grid.3x3.fill").tag(ViewMode.card)
                Image(systemName: "list.bullet").tag(ViewMode.list)
            }
            .pickerStyle(.segmented)
            .frame(width: 130)
        }
        .padding(16)
    }
    
    private func tagChip(name: String, count: Int, color: Color, selected: Bool = false, isAll: Bool = false) -> some View {
        HStack(spacing: 6) {
            if !isAll {
                Circle().fill(color).frame(width: 6, height: 6)
            }
            Text(name).font(.system(size: 13, weight: selected ? .bold : .medium))
            Text("\(count)")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(selected ? .white : .secondary)
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(selected ? AnyShapeStyle(.white.opacity(0.2)) : AnyShapeStyle(color.opacity(0.15)))
                .clipShape(Capsule())
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(selected ? AnyShapeStyle(color) : AnyShapeStyle(Color.secondary.opacity(0.08)))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(selected ? color : .clear, lineWidth: 1.5)
        )
        .foregroundStyle(selected ? .white : .primary)
    }
    
    private var cardGrid: some View {
        let cols = [GridItem(.adaptive(minimum: 180, maximum: 220), spacing: 14)]
        return ScrollView {
            LazyVGrid(columns: cols, spacing: 14) {
                ForEach(filteredComics) { c in
                    ComicCardView(comic: c,
                        onTap: { NotificationCenter.default.post(name: Notification.Name("OpenComicDetail"), object: c) },
                        onFavorite: { app.toggleFavorite(comic: c) }
                    )
                    .environmentObject(app)
                    .frame(maxWidth: .infinity)
                }
            }
            .padding(16)
        }
    }
    
    private var listView: some View {
        List(filteredComics) { c in
            HStack(spacing: 12) {
                AsyncImage(url: URL(string: c.cover ?? "")) { phase in
                    if let img = phase.image { img.resizable().aspectRatio(contentMode: .fill) }
                    else { Color.gray.opacity(0.2) }
                }
                .frame(width: 60, height: 80).clipped().cornerRadius(6)
                VStack(alignment: .leading, spacing: 4) {
                    Text(c.title).font(.headline).lineLimit(1)
                    Text(c.author ?? c.sourceId ?? "未知来源").font(.caption).foregroundStyle(.secondary)
                    HStack {
                        Text("\(c.chapters.count) 话").font(.caption2)
                        if let t = c.category, !t.isEmpty {
                            Text(t).font(.caption2).padding(.horizontal, 5).padding(.vertical, 1)
                                .background(Color.blue.opacity(0.15)).foregroundStyle(.blue).clipShape(Capsule())
                        }
                    }
                }
                Spacer()
                Image(systemName: "chevron.right").foregroundStyle(.tertiary).font(.caption)
            }
            .contentShape(Rectangle())
            .onTapGesture {
                NotificationCenter.default.post(name: Notification.Name("OpenComicDetail"), object: c)
            }
            .padding(.vertical, 4)
        }
        .listStyle(.inset)
    }
}