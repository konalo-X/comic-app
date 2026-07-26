// 后台任务队列（移植 comic-app/electron/jobqueue.js 的实用子集）
// 覆盖前端实际依赖：持久化队列 + 并发5工作池 + 优先级 + pause/resume/remove/retry
// + progress/done/queue-changed 事件 + 启动恢复
use crate::download;
use crate::settings;
use rusqlite::Connection;
use serde::Serialize;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use tauri::{AppHandle, Emitter};

const CONCURRENCY: usize = 5;
const MAX_RETRY: i64 = 3;

/// 安全获取 Mutex：容忍中毒，不 panic
fn safe_lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    match m.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

pub struct JobQueue {
    db_path: String,
    app: Mutex<Option<AppHandle>>,
    wake: Arc<(Mutex<bool>, Condvar)>,
    /// 仅用于「暂停」语义：pause 加入 / resume 移除
    paused_jobs: Mutex<std::collections::HashSet<String>>,
    /// 仅用于「删除/取消」语义：remove 加入 / claim 后或执行完清理
    cancelled_jobs: Mutex<std::collections::HashSet<String>>,
    started: AtomicBool,
}

#[derive(Serialize, Clone)]
pub struct JobView {
    pub id: String,
    #[serde(rename = "type")]
    pub job_type: String,
    pub priority: i64,
    pub status: String,
    pub payload: serde_json::Value,
    pub error: Option<String>,
    #[serde(rename = "progressTotal")]
    pub progress_total: i64,
    #[serde(rename = "progressCurrent")]
    pub progress_current: i64,
    pub progress: Option<serde_json::Value>,
    #[serde(rename = "retryCount")]
    pub retry_count: i64,
}

impl JobQueue {
    pub fn new(db_path: String) -> Arc<Self> {
        Arc::new(JobQueue {
            db_path,
            app: Mutex::new(None),
            wake: Arc::new((Mutex::new(false), Condvar::new())),
            paused_jobs: Mutex::new(std::collections::HashSet::new()),
            cancelled_jobs: Mutex::new(std::collections::HashSet::new()),
            started: AtomicBool::new(false),
        })
    }

    fn conn(&self) -> rusqlite::Result<Connection> {
        let c = Connection::open(&self.db_path)?;
        c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=8000;")?;
        Ok(c)
    }

    pub fn ensure_schema(&self) -> rusqlite::Result<()> {
        let c = self.conn()?;
        c.execute_batch(
            "CREATE TABLE IF NOT EXISTS job_queue (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                priority INTEGER DEFAULT 5,
                status TEXT DEFAULT 'waiting',
                payload TEXT,
                result TEXT,
                error TEXT,
                progress TEXT,
                progress_total INTEGER DEFAULT 0,
                progress_current INTEGER DEFAULT 0,
                retry_count INTEGER DEFAULT 0,
                max_retries INTEGER DEFAULT 3,
                created_at INTEGER,
                updated_at INTEGER,
                started_at INTEGER,
                completed_at INTEGER,
                last_progress_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_job_status ON job_queue(status);
            CREATE INDEX IF NOT EXISTS idx_job_priority ON job_queue(priority, created_at);",
        )?;
        Ok(())
    }

    pub fn set_app(&self, app: AppHandle) {
        *safe_lock(&self.app) = Some(app);
    }

    fn emit(&self, event: &str, payload: serde_json::Value) {
        if let Some(app) = safe_lock(&self.app).as_ref() {
            let _ = app.emit(event, payload);
        }
    }

    fn wake_workers(&self) {
        let (lock, cvar) = &*self.wake;
        let mut g = safe_lock(lock);
        *g = true;
        cvar.notify_all();
    }

    /// 启动恢复：active/running → waiting，失败/取消保持原状态
    pub fn recover(&self) -> rusqlite::Result<()> {
        let c = self.conn()?;
        c.execute(
            "UPDATE job_queue SET status='waiting', updated_at=? WHERE status IN ('active','running')",
            rusqlite::params![now_ms()],
        )?;
        // 恢复完成就唤醒一次 worker：避免冷启动有遗留 waiting 任务却没人触发信号
        self.wake_workers();
        Ok(())
    }

    /// 入队一个下载章节任务
    pub fn add_download_chapter(
        &self,
        comic_title: &str,
        chapter_index: i64,
        chapter_name: &str,
        chapter_url: &str,
        source_url: &str,
        referer: &str,
        priority: i64,
    ) -> rusqlite::Result<String> {
        let id = uuid_v4();
        let payload = json!({
            "comicTitle": comic_title,
            "chapterIndex": chapter_index,
            "chapterName": chapter_name,
            "chapterUrl": chapter_url,
            "sourceUrl": source_url,
            "referer": referer,
        });
        let c = self.conn()?;
        c.execute(
            "INSERT INTO job_queue (id,type,priority,status,payload,max_retries,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?)",
            rusqlite::params![
                id,
                "downloadChapter",
                priority,
                "waiting",
                payload.to_string(),
                MAX_RETRY,
                now_ms(),
                now_ms()
            ],
        )?;
        self.emit("job://enqueued", json!({"jobId": id, "type": "downloadChapter"}));
        self.emit("job://queue-changed", json!({}));
        self.wake_workers();
        Ok(id)
    }

    pub fn pause(&self, job_id: &str) -> rusqlite::Result<()> {
        let c = self.conn()?;
        c.execute(
            "UPDATE job_queue SET status='paused', updated_at=? WHERE id=? AND status IN ('waiting','active','running')",
            rusqlite::params![now_ms(), job_id],
        )?;
        safe_lock(&self.paused_jobs).insert(job_id.to_string());
        self.emit("job://paused", json!({"jobId": job_id}));
        self.emit("job://queue-changed", json!({}));
        Ok(())
    }

    pub fn resume(&self, job_id: &str) -> rusqlite::Result<()> {
        let c = self.conn()?;
        c.execute(
            "UPDATE job_queue SET status='waiting', updated_at=? WHERE id=? AND status='paused'",
            rusqlite::params![now_ms(), job_id],
        )?;
        safe_lock(&self.paused_jobs).remove(job_id);
        self.emit("job://resumed", json!({"jobId": job_id}));
        self.emit("job://queue-changed", json!({}));
        self.wake_workers();
        Ok(())
    }

    pub fn remove(&self, job_id: &str) -> rusqlite::Result<()> {
        // 先从数据库删除；若任务已 running，worker 会通过 cancelled_jobs 感知到中断
        let c = self.conn()?;
        c.execute("DELETE FROM job_queue WHERE id=?", rusqlite::params![job_id])?;
        // paused_jobs 也清理（如果是暂停状态删除）
        safe_lock(&self.paused_jobs).remove(job_id);
        // 放到 cancelled 集合，让正在执行该 id 的 worker 能及时中断并回写
        safe_lock(&self.cancelled_jobs).insert(job_id.to_string());
        self.emit("job://removed", json!({"jobId": job_id}));
        self.emit("job://queue-changed", json!({}));
        Ok(())
    }

    pub fn retry(&self, job_id: &str) -> rusqlite::Result<()> {
        let c = self.conn()?;
        // 重取：先确保清除 cancelled 标记，避免执行即被视为取消
        safe_lock(&self.cancelled_jobs).remove(job_id);
        safe_lock(&self.paused_jobs).remove(job_id);
        c.execute(
            "UPDATE job_queue SET status='waiting', retry_count=0, error=NULL, updated_at=? WHERE id=? AND status IN ('failed','cancelled','completed')",
            rusqlite::params![now_ms(), job_id],
        )?;
        self.emit("job://queue-changed", json!({}));
        self.wake_workers();
        Ok(())
    }

    pub fn retry_all(&self) -> rusqlite::Result<usize> {
        let c = self.conn()?;
        // 清空 cancelled 集合（历史取消标记不再生效）
        safe_lock(&self.cancelled_jobs).clear();
        let n = c.execute(
            "UPDATE job_queue SET status='waiting', retry_count=0, error=NULL, updated_at=? WHERE status IN ('failed','cancelled')",
            rusqlite::params![now_ms()],
        )?;
        self.emit("job://queue-changed", json!({}));
        self.wake_workers();
        Ok(n)
    }

    pub fn stats(&self) -> serde_json::Value {
        let c = match self.conn() {
            Ok(c) => c,
            Err(_) => return json!({}),
        };
        let mut stats = serde_json::Map::new();
        let mut total = 0i64;
        if let Ok(mut stmt) = c.prepare("SELECT status, COUNT(*) FROM job_queue GROUP BY status") {
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                .ok();
            if let Some(rows) = rows {
                for r in rows.flatten() {
                    total += r.1;
                    stats.insert(r.0, json!(r.1));
                }
            }
        }
        stats.insert("total".into(), json!(total));
        serde_json::Value::Object(stats)
    }

    pub fn list(&self, status: &str, limit: i64) -> Vec<JobView> {
        let c = match self.conn() {
            Ok(c) => c,
            Err(_) => return vec![],
        };
        let (where_clause, order): (String, String) = match status {
            "all" => ("1=1".into(), "priority ASC, created_at DESC".into()),
            "active" => (
                "status IN ('waiting','running','active','paused')".into(),
                "CASE status WHEN 'running' THEN 0 WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END ASC, priority ASC, created_at ASC".into(),
            ),
            s => (format!("status = '{}'", s.replace('\'', "")), "priority ASC, created_at DESC".into()),
        };
        let sql = format!(
            "SELECT id,type,priority,status,payload,error,progress,progress_total,progress_current,retry_count
             FROM job_queue WHERE {} ORDER BY {} LIMIT {}",
            where_clause, order, limit
        );
        let mut stmt = match c.prepare(&sql) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        let rows = stmt
            .query_map([], |r| {
                let payload_s: Option<String> = r.get(4)?;
                let progress_s: Option<String> = r.get(6)?;
                Ok(JobView {
                    id: r.get(0)?,
                    job_type: r.get(1)?,
                    priority: r.get(2)?,
                    status: r.get(3)?,
                    payload: payload_s
                        .and_then(|s| serde_json::from_str(&s).ok())
                        .unwrap_or(json!({})),
                    error: r.get(5)?,
                    progress: progress_s.and_then(|s| serde_json::from_str(&s).ok()),
                    progress_total: r.get(7)?,
                    progress_current: r.get(8)?,
                    retry_count: r.get(9)?,
                })
            })
            .ok();
        rows.map(|it| it.flatten().collect()).unwrap_or_default()
    }

    fn is_cancelled(&self, job_id: &str) -> bool {
        safe_lock(&self.cancelled_jobs).contains(job_id)
    }

    /// 启动工作池
    pub fn start(self: &Arc<Self>) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        for _ in 0..CONCURRENCY {
            let this = Arc::clone(self);
            std::thread::spawn(move || this.worker_loop());
        }
        // 所有 worker spawn 完就发一次全局唤醒：
        // recover() 可能在 start() 之前调用，那时 worker 还没起来信号就丢了；
        // 这里再补一波，保证启动后立即抢遗留 waiting。
        self.wake_workers();
    }

    fn worker_loop(self: Arc<Self>) {
        loop {
            // 先主动尝试 claim（避免「wake_workers 在 wait 之前调用导致信号丢失」）
            let mut job = self.claim_next_job();
            if job.is_none() {
                // ---------- 标准 Condvar 正确等待模式：while (!flag) { cvar.wait } ----------
                let (lock, cvar) = &*self.wake;
                let mut g = safe_lock(lock);
                // 循环检查：如果 *g == false，说明没有未处理的唤醒信号，才真正挂起等待。
                // 这样 ① wake 在 wait 前调用时（*g=true），不会丢信号；② 可正确处理伪唤醒。
                while !*g {
                    let (g2, _timeout_result) = cvar
                        .wait_timeout(g, std::time::Duration::from_secs(3))
                        .unwrap();
                    g = g2;
                }
                // 拿到信号就清 flag，下一轮等待会重新阻塞
                *g = false;
                drop(g);
                // 被唤醒后再 claim 一次
                job = self.claim_next_job();
            }
            match job {
                Some(j) => self.clone().run_job(j),
                None => {
                    // 唤醒后还是没任务，大概率是并发被别人抢走了，继续下一轮
                }
            }
        }
    }

    /// 原子领取下一个 waiting 任务（priority ASC, created_at ASC）
    /// 使用 BEGIN IMMEDIATE 真事务保证多线程不重复领取；遇到 SQLITE_BUSY 自动重试
    fn claim_next_job(&self) -> Option<ClaimedJob> {
        let mut retries: u32 = 0;
        loop {
            let c = match self.conn() {
                Ok(c) => c,
                Err(_) if retries < 5 => {
                    retries += 1;
                    std::thread::sleep(std::time::Duration::from_millis(30 * retries as u64));
                    continue;
                }
                Err(_) => return None,
            };
            // 真正的 BEGIN IMMEDIATE：保证同一时刻只有一个线程能进入 SELECT + UPDATE
            match c.execute_batch("BEGIN IMMEDIATE;") {
                Ok(()) => {}
                Err(rusqlite::Error::SqliteFailure(code, _))
                    if code.code == rusqlite::ErrorCode::DatabaseBusy && retries < 10 =>
                {
                    retries += 1;
                    std::thread::sleep(std::time::Duration::from_millis(25 * retries as u64));
                    continue;
                }
                Err(_) if retries < 5 => {
                    retries += 1;
                    std::thread::sleep(std::time::Duration::from_millis(30 * retries as u64));
                    continue;
                }
                Err(e) => {
                    eprintln!("[jobqueue] claim BEGIN IMMEDIATE 失败（放弃重试）：{e}");
                    return None;
                }
            }
            let commit_or_rollback = |c: &Connection, ok: bool| {
                let _ = if ok { c.execute_batch("COMMIT;") } else { c.execute_batch("ROLLBACK;") };
            };

            // 循环挑选：SELECT 到的任务如果被 cancelled/脏数据就跳到下一条，直到找到一个合法的或没数据
            let mut skip_ids: Vec<String> = Vec::new();
            let mut chosen: Option<(
                String,
                String,
                Option<String>,
                i64,
                i64,
            )> = None;
            loop {
                let skip_placeholders: Vec<String> = (0..skip_ids.len()).map(|_| "?".to_string()).collect();
                let sql = if skip_ids.is_empty() {
                    "SELECT id,type,payload,retry_count,max_retries FROM job_queue
                     WHERE status='waiting' ORDER BY priority ASC, created_at ASC LIMIT 1"
                        .to_string()
                } else {
                    format!(
                        "SELECT id,type,payload,retry_count,max_retries FROM job_queue
                         WHERE status='waiting' AND id NOT IN ({})
                         ORDER BY priority ASC, created_at ASC LIMIT 1",
                        skip_placeholders.join(",")
                    )
                };
                let mut stmt = match c.prepare(&sql) {
                    Ok(s) => s,
                    Err(_) => break,
                };
                let params: Vec<&dyn rusqlite::ToSql> =
                    skip_ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
                let row_result = stmt.query_row(rusqlite::params_from_iter(params.iter().copied()), |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, i64>(4)?,
                    ))
                });
                let row = match row_result {
                    Ok(r) => r,
                    Err(rusqlite::Error::QueryReturnedNoRows) => break,
                    Err(_) => {
                        commit_or_rollback(&c, false);
                        return None;
                    }
                };
                let (id, job_type, payload_s, retry_count, max_retries) = row;

                // 刚拿到 id 立即判断是否在 cancelled 集合：remove() 先删 DB 行，但这里有竞态，
                // 如果 id 不存在 (DELETE 已跑)，那 SELECT 就不会拿到；真拿到了就跳到下一条。
                if safe_lock(&self.cancelled_jobs).contains(&id) {
                    // 从 DB 清掉残留 id（remove 可能还没来得及删到这行）
                    let _ = c.execute("DELETE FROM job_queue WHERE id=?", rusqlite::params![id]);
                    safe_lock(&self.cancelled_jobs).remove(&id);
                    skip_ids.push(id);
                    continue;
                }
                // paused 状态的任务不会出现在 SELECT waiting 里，这里不用额外判断
                chosen = Some((id, job_type, payload_s, retry_count, max_retries));
                break;
            }

            let (id, job_type, payload_s, retry_count, max_retries) = match chosen {
                Some(r) => r,
                None => {
                    commit_or_rollback(&c, true);
                    return None;
                }
            };

            let now = now_ms();
            let upd = c.execute(
                "UPDATE job_queue SET status='running', started_at=?, last_progress_at=?, updated_at=? WHERE id=? AND status='waiting'",
                rusqlite::params![now, now, now, id],
            );
            match upd {
                Ok(1) => {
                    commit_or_rollback(&c, true);
                    return Some(ClaimedJob {
                        id,
                        job_type,
                        payload: payload_s
                            .and_then(|s| serde_json::from_str(&s).ok())
                            .unwrap_or(json!({})),
                        retry_count,
                        max_retries,
                    });
                }
                Ok(_) => {
                    // status 不是 waiting，说明被并发改了（pause/remove），事务回滚后立即重抢
                    // （不要直接 return None，否则这一轮唤醒就浪费了，任务看上去"空闲"）
                    commit_or_rollback(&c, false);
                    if retries < 5 {
                        retries += 1;
                        std::thread::yield_now();
                        continue;
                    }
                    return None;
                }
                Err(rusqlite::Error::SqliteFailure(code, _))
                    if code.code == rusqlite::ErrorCode::DatabaseBusy && retries < 10 =>
                {
                    commit_or_rollback(&c, false);
                    retries += 1;
                    std::thread::sleep(std::time::Duration::from_millis(25 * retries as u64));
                    continue;
                }
                Err(_) if retries < 5 => {
                    commit_or_rollback(&c, false);
                    retries += 1;
                    std::thread::sleep(std::time::Duration::from_millis(30 * retries as u64));
                    continue;
                }
                Err(e) => {
                    eprintln!("[jobqueue] claim UPDATE 失败：{e}");
                    commit_or_rollback(&c, false);
                    return None;
                }
            }
        }
    }

    fn run_job(self: Arc<Self>, job: ClaimedJob) {
        self.emit("job://active", json!({"jobId": job.id, "type": job.job_type}));
        // 领取后立即清除 cancelled 集合中的"脏标记"（remove → retry 之间可能残留）
        // —— 但如果真处于 cancelled，说明用户刚删，直接终止避免浪费资源
        if self.is_cancelled(&job.id) {
            self.finalize_cancelled(&job.id);
            return;
        }
        let result = match job.job_type.as_str() {
            "downloadChapter" => self.handle_download_chapter(&job, self.clone()),
            other => Err(format!("未知任务类型: {}", other)),
        };
        match result {
            Ok(_) => {
                if let Ok(c) = self.conn() {
                    let _ = c.execute(
                        "UPDATE job_queue SET status='completed', completed_at=?, updated_at=? WHERE id=?",
                        rusqlite::params![now_ms(), now_ms(), job.id],
                    );
                }
                // 执行完成就清理 cancelled 标记（如果有的话）
                safe_lock(&self.cancelled_jobs).remove(&job.id);
                self.emit("job://done", json!({"jobId": job.id, "type": job.job_type}));
                self.emit("job://queue-changed", json!({}));
            }
            Err(e) => {
                // 取消：DB 写 cancelled 状态（避免 recover → waiting 死循环），清理集合
                if self.is_cancelled(&job.id) {
                    self.finalize_cancelled(&job.id);
                    return;
                }
                let new_retry = job.retry_count + 1;
                if new_retry <= job.max_retries {
                    if let Ok(c) = self.conn() {
                        let _ = c.execute(
                            "UPDATE job_queue SET status='waiting', retry_count=?, error=?, updated_at=? WHERE id=?",
                            rusqlite::params![new_retry, e, now_ms(), job.id],
                        );
                    }
                    self.emit(
                        "job://retrying",
                        json!({"jobId": job.id, "retry": new_retry, "error": e}),
                    );
                    self.wake_workers();
                } else {
                    if let Ok(c) = self.conn() {
                        let _ = c.execute(
                            "UPDATE job_queue SET status='failed', error=?, updated_at=? WHERE id=?",
                            rusqlite::params![e, now_ms(), job.id],
                        );
                    }
                    self.emit("job://failed", json!({"jobId": job.id, "error": e}));
                }
                self.emit("job://queue-changed", json!({}));
            }
        }
    }

    /// 任务被取消时的收尾：写 cancelled 状态（DB 行已被 remove DELETE 就跳过）+ 清集合
    fn finalize_cancelled(&self, job_id: &str) {
        if let Ok(c) = self.conn() {
            // 影响行数=0 说明 remove() 已经把这行 DELETE 了，这是正常的
            let _ = c.execute(
                "UPDATE job_queue SET status='cancelled', error='cancelled by user', updated_at=? WHERE id=?",
                rusqlite::params![now_ms(), job_id],
            );
        }
        safe_lock(&self.cancelled_jobs).remove(job_id);
        self.emit("job://queue-changed", json!({}));
    }

    fn handle_download_chapter(&self, job: &ClaimedJob, self_arc: Arc<JobQueue>) -> Result<(), String> {
        let p = &job.payload;
        let comic_title = p.get("comicTitle").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let chapter_index = p.get("chapterIndex").and_then(|v| v.as_i64()).unwrap_or(0);
        let chapter_name = p.get("chapterName").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let chapter_url = p.get("chapterUrl").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let source_url = p.get("sourceUrl").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let referer = p.get("referer").and_then(|v| v.as_str()).unwrap_or("").to_string();

        if self.is_cancelled(&job.id) {
            return Err("cancelled".into());
        }

        let external = settings::external_download_root();
        // local_path 查询
        let local_path = {
            let c = self.conn().map_err(|e| e.to_string())?;
            crate::db::get_comic_by_url(&c, &source_url)
                .ok()
                .flatten()
                .and_then(|cm| cm.local_path)
        };
        let comic_dir =
            download::resolve_dir_for(&comic_title, local_path.as_deref(), external.as_deref())?;

        let cj = download::ChapterJob {
            comic_title: comic_title.clone(),
            chapter_index,
            chapter_name,
            chapter_url,
            referer,
            source_url,
        };

        let job_id = job.id.clone();
        let on_progress = Arc::new(move |cur: usize, total: usize| -> bool {
            if self_arc.is_cancelled(&job_id) {
                return false;
            }
            if let Ok(c) = self_arc.conn() {
                let _ = c.execute(
                    "UPDATE job_queue SET progress_current=?, progress_total=?, progress=?, last_progress_at=?, updated_at=? WHERE id=?",
                    rusqlite::params![
                        cur as i64,
                        total as i64,
                        json!({"downloaded": cur, "total": total}).to_string(),
                        now_ms(),
                        now_ms(),
                        job_id
                    ],
                );
            }
            self_arc.emit(
                "job://progress",
                json!({"jobId": job_id.clone(), "downloaded": cur, "total": total}),
            );
            true
        });

        let result = download::download_chapter(&cj, &comic_dir, on_progress)?;
        {
            let c = self.conn().map_err(|e| e.to_string())?;
            let _ = download::persist_chapter_result(&c, &cj, &result);
        }
        if result.failed > 0 {
            return Err(format!("{} 张图片下载失败", result.failed));
        }
        Ok(())
    }
}

struct ClaimedJob {
    id: String,
    job_type: String,
    payload: serde_json::Value,
    retry_count: i64,
    max_retries: i64,
}

pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// 轻量 uuid v4（避免额外依赖）
pub fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let a = nanos as u64;
    let b = (nanos >> 64) as u64 ^ std::process::id() as u64;
    let r = a.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (r >> 32) as u32,
        (r >> 16) as u16,
        (r & 0xfff) as u16,
        ((b >> 48) as u16 & 0x3fff) | 0x8000,
        b & 0xffffffffffff
    )
}