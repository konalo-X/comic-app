import SwiftUI

struct ShortcutUIItem: Identifiable {
    let id = UUID()
    let name: String
    let category: String
    let keyTokens: [String]
    let desc: String
}

struct ShortcutsView: View {
    @State private var filterCategory: String = "全部"
    
    private var allShortcuts: [ShortcutUIItem] {
        [
            .init(name: "刷新书架", category: "全局",
                  keyTokens: ["⌘", "R"],
                  desc: "重新从数据库加载漫画列表（不触发在线同步）"),
            .init(name: "同步全部漫画", category: "全局",
                  keyTokens: ["⌘", "⌥", "Y"],
                  desc: "对书架中每本漫画加入同步队列，更新章节信息"),
            .init(name: "通过 URL 添加漫画", category: "全局",
                  keyTokens: ["⌘", "L"],
                  desc: "在弹框中粘贴漫画详情页 URL 加入书架"),
            .init(name: "关闭窗口", category: "窗口",
                  keyTokens: ["⌘", "W"],
                  desc: "关闭当前活动窗口"),
            .init(name: "切换全屏", category: "窗口",
                  keyTokens: ["⌘", "⇧", "⏎"],
                  desc: "切换全屏显示模式"),
            .init(name: "上一页（阅读）", category: "阅读器",
                  keyTokens: ["←"],
                  desc: "阅读时，前进到上一页（单页模式）"),
            .init(name: "下一页（阅读）", category: "阅读器",
                  keyTokens: ["→"],
                  desc: "阅读时，后退到下一页"),
            .init(name: "上一页替代", category: "阅读器",
                  keyTokens: ["↑"],
                  desc: "向上方向键上翻页，也可用 PageUp"),
            .init(name: "下一页替代", category: "阅读器",
                  keyTokens: ["↓"],
                  desc: "向下方向键下翻页，也可用 PageDown / 空格"),
            .init(name: "回到第一页", category: "阅读器",
                  keyTokens: ["↖"],
                  desc: "回到本话第一页"),
            .init(name: "跳到末尾", category: "阅读器",
                  keyTokens: ["↘"],
                  desc: "跳到本话最后一页"),
            .init(name: "上一话", category: "阅读器",
                  keyTokens: ["⌘", "←"],
                  desc: "直接切换到上一话"),
            .init(name: "下一话", category: "阅读器",
                  keyTokens: ["⌘", "→"],
                  desc: "直接切换到下一话并自动加载"),
            .init(name: "退出阅读", category: "阅读器",
                  keyTokens: ["⎋"],
                  desc: "退出阅读器返回详情或书架"),
            .init(name: "书签 (暂存)", category: "阅读器",
                  keyTokens: ["B"],
                  desc: "保存当前页面为阅读进度"),
            .init(name: "切换阅读模式", category: "阅读器",
                  keyTokens: ["M"],
                  desc: "单页 / 双页 / 长卷 之间循环切换"),
            .init(name: "下载当前漫画", category: "详情",
                  keyTokens: ["D"],
                  desc: "从当前正在阅读的漫画所在话开始，后续所有话下载为 CBZ"),
            .init(name: "收藏/取消收藏", category: "详情/书架",
                  keyTokens: ["F"],
                  desc: "在详情页或选中卡片时切换收藏状态"),
            .init(name: "切换 FTS 搜索面板", category: "发现",
                  keyTokens: ["⌘", "F"],
                  desc: "调起搜索框，使用 FTS5 全文索引搜索标题/作者/标签"),
            .init(name: "删除选中项", category: "管理",
                  keyTokens: ["⌦"],
                  desc: "在章节管理 / 书架管理中删除选中条目"),
            .init(name: "全选", category: "管理",
                  keyTokens: ["⌘", "A"],
                  desc: "章节管理、下载管理表格全选"),
            .init(name: "打开设置", category: "系统",
                  keyTokens: ["⌘", ","],
                  desc: "打开应用设置面板"),
            .init(name: "撤销", category: "编辑",
                  keyTokens: ["⌘", "Z"],
                  desc: "撤销上一步输入或动作"),
            .init(name: "重做", category: "编辑",
                  keyTokens: ["⌘", "⇧", "Z"],
                  desc: "重做被撤销的动作")
        ]
    }
    
    var categories: [String] {
        ["全部"] + Array(Set(allShortcuts.map { $0.category })).sorted()
    }
    
    var list: [ShortcutUIItem] {
        if filterCategory == "全部" { return allShortcuts }
        return allShortcuts.filter { $0.category == filterCategory }
    }
    
    var body: some View {
        Form {
            Section("快捷键总览") {
                HStack(spacing: 8) {
                    Text("按分类过滤:")
                    Picker("分类", selection: $filterCategory) {
                        ForEach(categories, id: \.self) { Text($0).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                }
                .padding(.vertical, 4)
                Text("共 \(list.count) 条快捷键，可在系统 键盘设置→App 快捷键 中进一步修改。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            
            let grouped = Dictionary(grouping: list, by: { $0.category })
            ForEach(grouped.keys.sorted(), id: \.self) { cat in
                Section(cat) {
                    ForEach(grouped[cat] ?? []) { s in
                        HStack(alignment: .top, spacing: 12) {
                            HStack(spacing: 4) {
                                ForEach(s.keyTokens, id: \.self) { t in chip(t) }
                            }
                            .frame(width: 220, alignment: .trailing)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(s.name).font(.system(size: 13, weight: .semibold))
                                Text(s.desc).font(.caption2).foregroundStyle(.tertiary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
            
            Section("导出 / 备份") {
                HStack {
                    Button("复制为 Markdown") { copyAsMarkdown() }
                    Spacer()
                    Button("在系统设置中管理") {
                        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.keyboard")!)
                    }
                }
                .controlSize(.small)
            }
        }
        .formStyle(.grouped)
        .navigationTitle("快捷键")
    }
    
    private func chip(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold, design: .monospaced))
            .padding(.horizontal, 6).padding(.vertical, 3)
            .background(
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(.quaternary)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .strokeBorder(.tertiary.opacity(0.4), lineWidth: 0.5)
            )
    }
    
    private func copyAsMarkdown() {
        var md = "# 漫快 (ComicApp) 快捷键\n\n"
        let grouped = Dictionary(grouping: allShortcuts, by: { $0.category })
        for cat in grouped.keys.sorted() {
            md += "## \(cat)\n\n| 操作 | 按键 | 说明 |\n|---|---|---|\n"
            for s in grouped[cat] ?? [] {
                let ks = s.keyTokens.joined(separator: " + ")
                md += "| \(s.name) | `\(ks)` | \(s.desc) |\n"
            }
            md += "\n"
        }
        NSPasteboard.general.prepareForNewContents()
        NSPasteboard.general.setString(md, forType: .string)
    }
}