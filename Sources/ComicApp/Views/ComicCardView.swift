import SwiftUI

struct ComicCardView: View {
    let comic: Comic
    let onTap: () -> Void
    let onFavorite: () -> Void
    @State private var coverImage: NSImage? = nil
    @State private var loadFailed = false
    
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack(alignment: .topTrailing) {
                Group {
                    if let img = coverImage {
                        Image(nsImage: img)
                            .resizable()
                            .scaledToFill()
                    } else if loadFailed {
                        Rectangle()
                            .fill(LinearGradient(
                                colors: [Color.pink.opacity(0.3), Color.purple.opacity(0.3)],
                                startPoint: .topLeading, endPoint: .bottomTrailing
                            ))
                            .overlay {
                                VStack(spacing: 4) {
                                    Image(systemName: "book")
                                        .font(.system(size: 36))
                                        .foregroundStyle(.white.opacity(0.8))
                                    Text(comic.title.prefix(6))
                                        .font(.caption2)
                                        .foregroundStyle(.white)
                                        .lineLimit(1)
                                        .padding(.horizontal, 4)
                                }
                            }
                    } else {
                        Rectangle()
                            .fill(Color.gray.opacity(0.15))
                            .overlay { ProgressView().scaleEffect(0.7) }
                    }
                }
                .frame(width: 160, height: 220)
                .clipped()
                .cornerRadius(10)
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(Color.gray.opacity(0.15), lineWidth: 1)
                )
                .shadow(color: Color.black.opacity(0.08), radius: 4, x: 0, y: 2)
                
                Button(action: onFavorite) {
                    Image(systemName: comic.favorited == 1 ? "heart.fill" : "heart")
                        .foregroundStyle(comic.favorited == 1 ? .pink : .gray.opacity(0.8))
                        .frame(width: 28, height: 28)
                        .background(Circle().fill(.ultraThinMaterial))
                }
                .buttonStyle(.plain)
                .padding(8)
                
                if comic.updateDelta > 0 {
                    Text("+\(comic.updateDelta)")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Capsule().fill(Color.orange))
                        .padding([.top, .leading], 8)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                }
            }
            
            Text(comic.title)
                .font(.system(size: 13, weight: .medium))
                .lineLimit(2)
                .frame(height: 34, alignment: .topLeading)
                .frame(maxWidth: .infinity, alignment: .leading)
            
            HStack(spacing: 6) {
                if let author = comic.author, !author.isEmpty {
                    Text(author)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                Text("\(comic.chapterCount)话")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Capsule().fill(Color.gray.opacity(0.1)))
            }
        }
        .frame(width: 160)
        .contentShape(Rectangle())
        .onTapGesture(perform: onTap)
        .onAppear(perform: loadCover)
    }
    
    private func loadCover() {
        if coverImage != nil { return }
        let path = comic.localCover ?? CacheManager.shared.getCoverLocalPath(sourceUrl: comic.sourceUrl)
        if let path, let img = NSImage(contentsOfFile: path) {
            coverImage = img
            return
        }
        guard let urlStr = comic.cover, let url = URL(string: urlStr) else {
            loadFailed = true
            return
        }
        Task.detached {
            do {
                let data = try await SourceRegistry.shared.fetchImage(imageUrl: urlStr, referer: comic.sourceUrl)
                let nsimg = NSImage(data: data)
                if let img = nsimg {
                    try? CacheManager.shared.saveCover(data: data, sourceUrl: comic.sourceUrl)
                    await MainActor.run { self.coverImage = img }
                } else {
                    await MainActor.run { self.loadFailed = true }
                }
            } catch {
                await MainActor.run { self.loadFailed = true }
            }
        }
        _ = url
    }
}