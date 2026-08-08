import SwiftUI
import AppKit

struct ReaderView: View {
    @EnvironmentObject var reader: ReaderStore
    @State private var showSidebar = true
    @State private var showControls = true
    @State private var hideControlsTimer: Timer? = nil
    @State private var zoom: CGFloat = 1.0
    
    var body: some View {
        ZStack(alignment: .top) {
            if reader.comic == nil {
                emptyReader
            } else {
                HStack(spacing: 0) {
                    if showSidebar { chapterPanel }
                    contentArea
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            if reader.comic != nil && showControls {
                overlayControls
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.opacity(0.96))
        .onTapGesture(count: 2) {
            if reader.readingMode == .flip {
                if reader.pageDirection == .rtl {
                    reader.prevPage()
                } else {
                    reader.nextPage()
                }
            }
        }
        .onTapGesture(count: 1) {
            if reader.readingMode == .scroll { return }
            scheduleHideControls()
        }
        .onLongPressGesture { withAnimation { showControls.toggle() } }
        .gesture(
            DragGesture(minimumDistance: 40)
                .onEnded { v in
                    guard reader.readingMode == .flip else { return }
                    let dx = v.translation.width
                    let dy = v.translation.height
                    if reader.pageDirection == .ttb {
                        if dy < -20 { reader.nextPage() }
                        else if dy > 20 { reader.prevPage() }
                    } else {
                        if reader.pageDirection == .rtl {
                            if dx > 30 { reader.nextPage() }
                            else if dx < -30 { reader.prevPage() }
                        } else {
                            if dx < -30 { reader.nextPage() }
                            else if dx > 30 { reader.prevPage() }
                        }
                    }
                }
        )
        .focusable()
        .onKeyPress(.rightArrow) { if reader.pageDirection == .rtl { reader.prevPage() } else { reader.nextPage() }; return .handled }
        .onKeyPress(.leftArrow)  { if reader.pageDirection == .rtl { reader.nextPage() } else { reader.prevPage() }; return .handled }
        .onKeyPress(.downArrow)  { reader.nextPage(); return .handled }
        .onKeyPress(.upArrow)    { reader.prevPage(); return .handled }
        .onKeyPress(.space)      { reader.nextPage(); return .handled }
    }
    
    private var emptyReader: some View {
        VStack(spacing: 16) {
            Image(systemName: "book").font(.system(size: 64)).foregroundStyle(.secondary.opacity(0.5))
            Text("选择一本书开始阅读").font(.title3).foregroundStyle(.secondary)
            Text("在书架中双击卡片，或从详情页点击「开始阅读」")
                .font(.callout).foregroundStyle(.tertiary)
        }
    }
    
    private var chapterPanel: some View {
        VStack(spacing: 0) {
            HStack {
                Text(reader.comic?.title ?? "").font(.headline).lineLimit(2)
                Spacer()
                Button(action: { withAnimation { showSidebar.toggle() } }) {
                    Image(systemName: "sidebar.snippets.left").foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(Array(reader.chapters.enumerated()), id: \.element.id) { idx, ch in
                            let chapterName: String = {
                                if ch.name.isEmpty {
                                    return "第\(idx + 1)话"
                                } else {
                                    return ch.name
                                }
                            }()
                            let isCurrent = idx == reader.currentChapterIndex
                            Button(action: { reader.goToChapter(index: idx) }) {
                                HStack(spacing: 8) {
                                    Text(String(format: "%04d", idx + 1))
                                        .font(.system(.caption2, design: .monospaced))
                                        .foregroundStyle(.tertiary)
                                    Text(chapterName)
                                        .lineLimit(1)
                                        .font(.system(size: 13))
                                        .foregroundStyle(isCurrent ? .white : .secondary)
                                    Spacer(minLength: 0)
                                    if isCurrent {
                                        Image(systemName: "play.circle.fill")
                                            .foregroundStyle(Color.accentColor)
                                    }
                                }
                                .padding(.vertical, 7).padding(.horizontal, 10)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(
                                    RoundedRectangle(cornerRadius: 6)
                                        .fill(isCurrent
                                              ? Color.accentColor.opacity(0.35)
                                              : Color.clear)
                                )
                            }
                            .buttonStyle(.plain)
                            .id(idx)
                        }
                    }
                    .padding(8)
                }
                .onChange(of: reader.currentChapterIndex) { _, idx in
                    withAnimation { proxy.scrollTo(idx, anchor: .center) }
                }
            }
        }
        .frame(width: 280)
        .background(.ultraThinMaterial)
    }
    
    @ViewBuilder
    private var contentArea: some View {
        if reader.isLoading {
            ProgressView("正在加载章节...")
                .controlSize(.large)
                .foregroundStyle(.white)
        } else if !reader.pageUrls.isEmpty {
            if reader.readingMode == .scroll {
                scrollViewContent
            } else {
                flipViewContent
            }
        } else if let err = reader.errorMessage {
            VStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 40))
                    .foregroundStyle(.orange)
                Text("加载失败").font(.headline).foregroundStyle(.white)
                Text(err).font(.callout).foregroundStyle(.secondary)
                Button("重试") { reader.goToChapter(index: reader.currentChapterIndex) }
                    .buttonStyle(.borderedProminent)
            }
        } else {
            Text("本章无图片").foregroundStyle(.secondary)
        }
    }
    
    private var scrollViewContent: some View {
        GeometryReader { geo in
            ScrollView {
                LazyVStack(spacing: 2) {
                    ForEach(Array(reader.pageUrls.enumerated()), id: \.offset) { idx, url in
                        ReaderPageView(url: url, index: idx)
                            .environmentObject(reader)
                            .frame(width: max(0, geo.size.width * zoom))
                            .frame(maxWidth: .infinity)
                    }
                }
                .padding(.vertical, showControls ? 90 : 16)
                .frame(maxWidth: .infinity)
            }
        }
    }
    
    private var flipViewContent: some View {
        GeometryReader { geo in
            ZStack {
                if reader.currentPageIndex < reader.pageUrls.count {
                    let url = reader.pageUrls[reader.currentPageIndex]
                    ReaderPageView(url: url, index: reader.currentPageIndex, autoLoad: true)
                        .environmentObject(reader)
                        .scaledToFit()
                        .frame(width: max(1, geo.size.width),
                               height: max(1, geo.size.height))
                        .scaleEffect(zoom)
                        .gesture(MagnificationGesture()
                            .onChanged { v in zoom = max(0.5, min(3.0, v)) }
                            .onEnded { _ in if zoom < 1.05 { zoom = 1.0 } })
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(alignment: .bottom) {
                pageNavOverlay.frame(width: min(geo.size.width, 420))
            }
        }
        .padding(.top, showControls ? 70 : 0)
        .padding(.bottom, showControls ? 130 : 0)
    }
    
    private var pageNavOverlay: some View {
        HStack(spacing: 4) {
            Button(action: reader.prevPage) {
                Image(systemName: "chevron.left.circle.fill").font(.system(size: 26))
            }
            .buttonStyle(.plain)
            .disabled(reader.currentPageIndex == 0 && reader.currentChapterIndex == 0)
            
            VStack(spacing: 2) {
                Slider(value: Binding(
                    get: { Double(reader.currentPageIndex) },
                    set: { reader.setPage(Int($0.rounded())) }
                ), in: 0...Double(max(0, reader.pageUrls.count - 1)))
                .tint(.white.opacity(0.8))
                Text(reader.pageUrls.isEmpty ? "0 / 0" : "\(reader.currentPageIndex + 1) / \(reader.pageUrls.count)")
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.75))
            }
            
            Button(action: reader.nextPage) {
                Image(systemName: "chevron.right.circle.fill").font(.system(size: 26))
            }
            .buttonStyle(.plain)
            .disabled(reader.currentPageIndex >= reader.pageUrls.count - 1
                      && reader.currentChapterIndex >= reader.chapters.count - 1)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
        .padding(.bottom, 8)
    }
    
    private var overlayControls: some View {
        VStack(spacing: 0) {
            topOverlay
            Spacer()
            bottomOverlay
        }
        .transition(.opacity.combined(with: .move(edge: .top)))
    }
    
    private var topOverlay: some View {
        HStack(spacing: 10) {
            Button(action: { NotificationCenter.default.post(name: Notification.Name.switchTab, object: "bookshelf") }) {
                Image(systemName: "chevron.left").frame(width: 30, height: 30)
            }
            .buttonStyle(.plain)
            VStack(alignment: .leading, spacing: 2) {
                Text(reader.chapterName ?? (reader.chapters.indices.contains(reader.currentChapterIndex)
                                            ? reader.chapters[reader.currentChapterIndex].name
                                            : "")).font(.headline).foregroundStyle(.white).lineLimit(1)
                Text("第 \(reader.currentChapterIndex + 1) / \(reader.chapters.count) 话")
                    .font(.caption).foregroundStyle(.white.opacity(0.6))
            }
            Spacer()
            Button(action: reader.prevChapter) {
                Image(systemName: "chevron.backward.to.line")
            }.disabled(reader.currentChapterIndex == 0)
            Button(action: reader.nextChapter) {
                Image(systemName: "chevron.forward.to.line")
            }.disabled(reader.currentChapterIndex >= reader.chapters.count - 1)
            Divider().frame(height: 20)
            Button(action: { withAnimation { showSidebar.toggle() } }) {
                Image(systemName: "list.bullet.rectangle")
            }
            Menu {
                Picker("阅读模式", selection: $reader.readingMode) {
                    ForEach(ReaderStore.ReadingMode.allCases) { m in Text(m.label).tag(m) }
                }
                Picker("阅读方向", selection: $reader.pageDirection) {
                    ForEach(ReaderStore.PageDirection.allCases) { d in Text(d.label).tag(d) }
                }
            } label: {
                Image(systemName: "gear")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(.ultraThinMaterial)
        .foregroundStyle(.white)
        .buttonStyle(.plain)
    }
    
    private var bottomOverlay: some View {
        HStack(spacing: 14) {
            HStack(spacing: 6) {
                Image(systemName: "eye").foregroundStyle(.white.opacity(0.8))
                Text(reader.pageUrls.isEmpty ? "0/0" : "\(reader.currentPageIndex + 1)/\(reader.pageUrls.count)")
                    .font(.caption).foregroundStyle(.white.opacity(0.85))
                Text(String(format: "%.0f%%", reader.pageUrls.isEmpty ? 0 :
                            Double(reader.currentPageIndex + 1) / Double(reader.pageUrls.count) * 100))
                    .font(.caption2).foregroundStyle(.white.opacity(0.5))
            }
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: 8).fill(.white.opacity(0.1)))
            
            ProgressView(value: reader.pageUrls.isEmpty ? 0
                         : Double(reader.currentChapterIndex * 1000 + reader.currentPageIndex + 1),
                         total: max(1, Double(reader.chapters.count * 1000 + 0)))
            .progressViewStyle(.linear)
            .tint(.accentColor)
            
            HStack(spacing: 2) {
                Button {
                    zoom = max(0.5, zoom - 0.1)
                } label: { Image(systemName: "minus.magnifyingglass") }
                Text(String(format: "%.0f%%", zoom * 100))
                    .font(.caption2).frame(width: 44)
                Button {
                    zoom = min(3.0, zoom + 0.1)
                } label: { Image(systemName: "plus.magnifyingglass") }
                Button { zoom = 1.0 } label: { Image(systemName: "arrow.down.left.and.arrow.up.right") }
            }
            .foregroundStyle(.white)
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(.ultraThinMaterial)
    }
    
    private func scheduleHideControls() {
        hideControlsTimer?.invalidate()
        withAnimation { showControls = true }
        hideControlsTimer = Timer.scheduledTimer(withTimeInterval: 2.8, repeats: false) { _ in
            DispatchQueue.main.async {
                withAnimation { if reader.readingMode == .flip { showControls = false } }
            }
        }
    }
}

struct ReaderPageView: View {
    let url: String
    let index: Int
    var autoLoad: Bool = true
    @EnvironmentObject var reader: ReaderStore
    @State private var data: Data? = nil
    @State private var loadError = false
    @State private var isLoading = false
    
    var body: some View {
        ZStack {
            if let d = data, let img = NSImage(data: d) {
                Image(nsImage: img)
                    .resizable()
                    .scaledToFit()
            } else if loadError {
                VStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                    Text("加载失败").font(.caption).foregroundStyle(.white.opacity(0.8))
                    Button("重试", action: startLoad)
                        .buttonStyle(.bordered).controlSize(.mini)
                }
                .padding().frame(maxWidth: .infinity, minHeight: 400)
            } else {
                Color.white.opacity(0.04).frame(maxWidth: .infinity, minHeight: 400).overlay {
                    if isLoading { ProgressView().progressViewStyle(.circular).controlSize(.small).colorScheme(.dark) }
                }
            }
        }
        .onAppear(perform: startLoad)
        .frame(maxWidth: .infinity)
    }
    
    private func startLoad() {
        if let cached = reader.pageData(url) { data = cached; return }
        if let d = CacheManager.shared.getCachedImage(url: url) { data = d; return }
        guard autoLoad || index - reader.currentPageIndex <= 3 else { return }
        guard !isLoading else { return }
        loadError = false
        isLoading = true
        reader.loadPageImageIfNeeded(url)
        Task {
            var tries = 0
            while tries < 30 {
                try? await Task.sleep(nanoseconds: 150_000_000)
                if let d = reader.pageData(url) {
                    await MainActor.run { self.data = d; self.isLoading = false }
                    return
                }
                tries += 1
            }
            await MainActor.run { self.isLoading = false; self.loadError = true }
        }
    }
}