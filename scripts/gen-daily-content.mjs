// 每日学习内容生成脚本（供 GitHub Actions 定时运行，也可本地手动运行）。
// 生成两部分内容并写入仓库的 content/ 目录（按日期命名），随后 git 提交推送：
//   - content/words/<YYYY-MM-DD>.json   单词卡（含释义/例句）
//   - content/articles/<YYYY-MM-DD>.json   文章（含正文/核心词汇/长难句）
//   - content/manifest.json            清单（供前端运行时拉取）
//
// 依赖环境变量：
//   LLM_API_KEY     必填，OpenAI 兼容接口的 API Key（如 OpenAI / DeepSeek / Moonshot）
//   LLM_BASE_URL    可选，默认 https://api.openai.com/v1
//   LLM_MODEL       可选，默认 gpt-4o-mini
//   GH_TOKEN        Git 推送令牌；缺省用 Actions 自带的 GITHUB_TOKEN
//   CONTENT_DIR     可选，内容目录，默认仓库根目录下的 content
//
// 无 LLM_API_KEY 时直接退出（不报错），避免定时任务空跑时邮件轰炸。

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

const BASE_URL = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
const MODEL = process.env.LLM_MODEL || 'gpt-4o-mini'
const API_KEY = process.env.LLM_API_KEY
const CONTENT_DIR = process.env.CONTENT_DIR || 'content'
// 温度：Kimi-K2 / deepseek-reasoner 等推理模型仅接受 temperature=1，其他模型（OpenAI/DeepSeek 经典模型）接受 0-2。
// 默认 1 对推理模型最安全（避免 400），经典模型也接受 1；如需更确定性的非推理输出，设 LLM_TEMPERATURE=0.7。
const TEMPERATURE = Number(process.env.LLM_TEMPERATURE ?? 1)
// 单次 LLM 调用超时：Kimi-K2 等推理模型首次响应可达 1–2 分钟，默认 180s；
// 也可通过环境变量 LLM_TIMEOUT_MS 调大或调小。
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 180000)
// 内容日期按北京时间（UTC+8）计算，避免 GitHub Actions 定时延迟造成跨时区日期错位：
//   定时任务可能延迟数小时才执行，用 UTC 日期会把当天内容标成前一天/后一天。
//   DATE_OFFSET_HOURS 可用环境变量覆盖（默认 +8 = 北京时间）。
const DATE_OFFSET_HOURS = Number(process.env.DATE_OFFSET_HOURS ?? 8)
const DATE = new Date(Date.now() + DATE_OFFSET_HOURS * 3600 * 1000).toISOString().slice(0, 10)

function log(...a) { console.log('[gen-content]', ...a) }

async function callLLM(system, user) {
  if (!API_KEY) {
    console.error('[gen-content] 未配置 LLM_API_KEY，跳过生成')
    process.exit(0)
  }
  const body = JSON.stringify({
    model: MODEL,
    temperature: TEMPERATURE,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  })

  let lastErr
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctrl = new AbortController()
    const started = Date.now()
    const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS)
    const beat = setInterval(() => {
      log(`仍在等待模型响应…${Math.round((Date.now() - started) / 1000)}s`)
    }, 20000)
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body,
        signal: ctrl.signal
      })
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        throw new Error(`LLM HTTP ${res.status}: ${txt.slice(0, 300)}`)
      }
      const json = await res.json()
      const raw = json.choices?.[0]?.message?.content || ''
      // 提取第一个 {...} 块，兼容模型偶尔的啰嗦输出
      const m = raw.match(/\{[\s\S]*\}/)
      if (!m) throw new Error('LLM 未返回 JSON：' + raw.slice(0, 200))
      return JSON.parse(m[0])
    } catch (e) {
      lastErr = e
      const msg = e instanceof Error ? e.message : String(e)
      log(`第 ${attempt} 次调用失败（${Math.round((Date.now() - started) / 1000)}s）：${msg}`)
      // 4xx 属于请求参数/权限问题，重试无意义
      if (/LLM HTTP 4\d\d/.test(msg)) throw e
      if (attempt < 3) await new Promise((r) => setTimeout(r, 5000))
    } finally {
      clearTimeout(timer)
      clearInterval(beat)
    }
  }
  throw lastErr
}

function readManifest() {
  const p = `${CONTENT_DIR}/manifest.json`
  if (existsSync(p)) {
    try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return [] }
  }
  return []
}

async function main() {
  mkdirSync(`${CONTENT_DIR}/words`, { recursive: true })
  mkdirSync(`${CONTENT_DIR}/articles`, { recursive: true })
  const manifest = readManifest()
  const exists = new Set(manifest.map((e) => `${e.type}_${e.date}`))

  // 1) 单词：法律/合规/通用商务英语主题，10 个（带历史去重 + 主题轮换 + 内部去重）
  if (!exists.has(`words_${DATE}`)) {
    // 读取最近 N 天的所有词文件，提取 term，构建禁用列表，避免 LLM 重复生成
    const LOOKBACK_DAYS = 7
    const recentTerms = new Set()
    const recentByDate = []
    const sortedWordDates = [...new Set(manifest.filter((e) => e.type === 'words').map((e) => e.date))].sort()
    for (const d of sortedWordDates.slice(-LOOKBACK_DAYS)) {
      const p = `${CONTENT_DIR}/words/${d}.json`
      if (existsSync(p)) {
        try {
          const data = JSON.parse(readFileSync(p, 'utf8'))
          const terms = []
          for (const w of data.words || []) {
            const t = (w?.term || '').toLowerCase().trim()
            if (t) {
              recentTerms.add(t)
              terms.push(t)
            }
          }
          if (terms.length) recentByDate.push({ date: d, terms })
        } catch {}
      }
    }
    const forbidden = [...recentTerms]
    log(`已加载最近 ${LOOKBACK_DAYS} 天 ${forbidden.length} 个历史词条作为禁用列表`)

    // 主题轮换池：避免每天都是「法律合规与商事争议解决核心术语」导致内容同质化
    // 按 DATE 取哈希选一个主题，确保可复现但相邻日期不重复
    const THEME_POOL = [
      { zh: '公司法与公司治理核心术语', en: 'Corporate Law & Governance' },
      { zh: '合同法与商业交易精要', en: 'Contract Law & Commercial Transactions' },
      { zh: '合规与监管法律术语', en: 'Regulatory Compliance Essentials' },
      { zh: '商事争议解决与诉讼核心术语', en: 'Commercial Dispute Resolution & Litigation' },
      { zh: '内部调查与合规调查关键术语', en: 'Internal Investigations & Compliance Audits' },
      { zh: '反垄断与反不正当竞争术语', en: 'Antitrust & Unfair Competition' },
      { zh: '数据合规与隐私保护术语', en: 'Data Compliance & Privacy Protection' },
      { zh: '跨境贸易与制裁合规术语', en: 'Cross-border Trade & Sanctions Compliance' },
      { zh: '知识产权与商业秘密术语', en: 'Intellectual Property & Trade Secrets' },
      { zh: '并购重组与资本市场核心术语', en: 'M&A Restructuring & Capital Markets' }
    ]
    const dayHash = [...DATE].reduce((a, c) => a + c.charCodeAt(0), 0)
    const themeHint = THEME_POOL[dayHash % THEME_POOL.length]

    const WORD_SYSTEM =
      '你是英语词汇教学助手。只输出 JSON，不要任何额外文字。结构：{"theme":"中文主题","theme_en":"英文主题","words":[{"term":"英文单词","ipa":"音标","cn_meaning":"中文释义","collins_def":"英文权威释义","pron_tip":"发音/记忆提示（可选）","examples":[{"en":"英文例句","cn":"例句中文"}]}]}。主题为当天精选，围绕法律合规、商业、职场常用词，难度中等偏上。'

    // 把禁用词放进 prompt（最多 80 个，超出提示总数），并明确说"绝对不要重复"
    const forbiddenPreview = forbidden.slice(0, 80).join(', ')
    const forbiddenTail = forbidden.length > 80 ? `, …（共 ${forbidden.length} 个，已省略）` : ''
    const forbiddenBlock =
      forbidden.length > 0
        ? `\n\n**关键约束：以下 ${forbidden.length} 个词在最近 ${LOOKBACK_DAYS} 天已经生成过，绝对不要重复，必须从这之外选新词**：\n${forbiddenPreview}${forbiddenTail}`
        : ''

    const WORD_USER = `请为 ${DATE} 生成 **15 个**值得学习的英文单词（多给 5 个以便去重），适合中国法律/合规从业者。**当日主题聚焦「${themeHint.zh}」（${themeHint.en}）**，请围绕该主题选词，避免与基础小学词汇重复。${forbiddenBlock}`

    // 最多重试 3 次；每次都把"上一次有重复的词"加进禁用列表，进一步收紧
    let out = null
    let cumulativeForbidden = new Set(forbidden)
    for (let attempt = 1; attempt <= 3; attempt++) {
      log(`单词生成尝试 ${attempt}/3（已禁用 ${cumulativeForbidden.size} 个历史词）`)
      const userPrompt =
        cumulativeForbidden.size > forbidden.length
          ? `${WORD_USER}\n\n**额外约束：上一轮生成中仍有重复，下列词也必须避开**：${[...cumulativeForbidden].slice(forbidden.length).join(', ')}`
          : WORD_USER
      const words = await callLLM(WORD_SYSTEM, userPrompt)
      const raw = (Array.isArray(words.words) ? words.words : []).slice(0, 15)

      // 去重 1：与历史 + 上一轮累积去重
      const seen = new Set(cumulativeForbidden)
      const unique = []
      const dupInResult = []
      for (const w of raw) {
        const t = (w?.term || '').toLowerCase().trim()
        if (!t) continue
        if (seen.has(t)) {
          dupInResult.push(t)
          continue
        }
        seen.add(t)
        unique.push(w)
      }
      log(`第 ${attempt} 轮：原始 ${raw.length} 个，与历史去重后剩 ${unique.length} 个（重复 ${dupInResult.length} 个：${dupInResult.slice(0, 5).join(', ')}${dupInResult.length > 5 ? '…' : ''}）`)

      if (unique.length >= 10) {
        out = {
          theme: words.theme || themeHint.zh,
          theme_en: words.theme_en || themeHint.en,
          words: unique.slice(0, 10),
          used_terms: unique.slice(0, 10).map((w) => w.term)
        }
        break
      } else {
        // 把这一轮重复的词加进累积禁用，下次提示时收紧
        for (const t of dupInResult) cumulativeForbidden.add(t)
        if (attempt === 3) {
          // 最后一次还不够 10 个，全部保留 + 警告
          out = {
            theme: words.theme || themeHint.zh,
            theme_en: words.theme_en || themeHint.en,
            words: unique,
            used_terms: unique.map((w) => w.term)
          }
        }
      }
    }

    writeFileSync(`${CONTENT_DIR}/words/${DATE}.json`, JSON.stringify(out, null, 2))
    manifest.push({ type: 'words', date: DATE, file: `words/${DATE}.json` })
    log('已生成单词', out.words.length)
    if (out.words.length < 10) {
      console.warn(`[gen-content] 警告：单词只有 ${out.words.length} 个（目标 10 个），可在 Actions 日志查具体遗漏`)
    }
  }

  // 2) 文章：每天 2 篇 —— 一篇专业主题 + 一篇兴趣主题（分两次调用更稳）
  if (!exists.has(`articles_${DATE}`)) {
    const ART_SYSTEM =
      '你是英文阅读教学作者。只输出 JSON，不要任何额外文字。结构：{"articles":[{"title":"标题","body":["第1段正文","第2段正文","1. **单词** — 英文释义","1. \\"原句\\"","- 主句：拆解","- 从句：拆解"],"comprehension":[{"q":"英文题干","options":["A. 选项一","B. 选项二","C. 选项三","D. 选项四"],"answer":"B","explanation":"中文解析：说明正确答案在文中的依据"}]}]}。body 是字符串数组：前几段为正文，之后可追加「1. **词汇** — 释义」与「1. \\"原句\\"」+「- 标签：内容」形式的拆解（前端会自动切分）。comprehension 是 **3-5 道英文阅读理解选择题**，必须严格依据正文事实出题（建议 1 题主旨题 + 1-2 题细节题 + 1 题推断题，另可加 1 题词汇猜测题），每题 4 个选项，answer 为大写字母且必须与 options 中的正确项对应，explanation 用中文说明依据。**必须返回且仅返回 1 篇文章**（articles 数组长度为 1），每篇 250-400 词。'
    const topicPlans = [
      {
        label: '专业',
        user: `请为 ${DATE} 生成 1 篇专业主题的英文阅读素材，难度中上。主题必须从「反洗钱」「公司治理」「反不正当竞争」「内部调查」「AI 治理」「商业贿赂」中选一个具体角度切入，贴近实务、有观点和细节。`
      },
      {
        label: '兴趣',
        user: `请为 ${DATE} 生成 1 篇基于个人兴趣的英文阅读素材，难度中上、笔调轻快有温度。主题必须从「BTS 与 K-pop 音乐文化」「花样滑冰（选手/赛事/艺术性）」「宠物（猫/狗的行为与陪伴）」「社会学观察（城市、社群、日常生活中的社会现象）」中选一个具体角度切入。`
      }
    ]
    // 阅读理解题清洗：只保留题干、选项、有效答案齐全的题（answer 为大写字母且落在选项范围内）
    const cleanComprehension = (comps) => {
      const letters = 'ABCDEFG'
      const cleaned = (Array.isArray(comps) ? comps : [])
        .map((c) => ({
          q: String(c?.q ?? '').trim(),
          options: Array.isArray(c?.options) ? c.options.map((o) => String(o).trim()).filter(Boolean) : [],
          answer: String(c?.answer ?? '').trim().toUpperCase().replace(/[^A-G]/g, ''),
          explanation: String(c?.explanation ?? '').trim()
        }))
        .filter((c) => c.q && c.options.length >= 2 && c.answer && letters.indexOf(c.answer) < c.options.length)
      return cleaned.length ? cleaned : null
    }
    const articles = []
    for (const plan of topicPlans) {
      try {
        const art = await callLLM(ART_SYSTEM, plan.user)
        const a = Array.isArray(art.articles) ? art.articles[0] : null
        if (a && Array.isArray(a.body) && a.body.length) {
          const comps = cleanComprehension(a.comprehension)
          if (comps) {
            a.comprehension = comps
            log(`${plan.label}文章阅读理解题：`, comps.length, '道')
          } else {
            console.warn(`[gen-content] ${plan.label}文章阅读理解题缺失或无效，已跳过该字段`)
            delete a.comprehension
          }
          articles.push(a)
          log(`已生成${plan.label}文章：`, a.title || '(无标题)')
        } else {
          console.warn(`[gen-content] ${plan.label}文章返回为空`)
        }
      } catch (e) {
        console.warn(`[gen-content] 生成${plan.label}文章失败：`, e instanceof Error ? e.message : e)
      }
    }
    // 兜底：不足 2 篇时补占位，保证每天至少 2 个入口
    while (articles.length < 2) {
      console.warn('[gen-content] 文章不足 2 篇，补 1 篇占位')
      articles.push({
        title: `补充阅读 · ${DATE}`,
        body: [
          `This is a placeholder article generated on ${DATE}. One of the daily article generations failed or returned an empty body. Please review the GitHub Actions log to see which topic call failed, then rerun the workflow.`,
          '1. **placeholder** — a stand-in entry used when one of the two daily article generations failed.'
        ]
      })
    }
    const data = { articles: articles.slice(0, 2) }
    writeFileSync(`${CONTENT_DIR}/articles/${DATE}.json`, JSON.stringify(data, null, 2))
    manifest.push({ type: 'articles', date: DATE, file: `articles/${DATE}.json` })
    log('已生成文章', data.articles.length)
  }

  writeFileSync(`${CONTENT_DIR}/manifest.json`, JSON.stringify(manifest, null, 2))

  // 3) 提交并推送（若内容有变化）
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!token) { log('未提供 GH_TOKEN，跳过 git 推送'); return }
  execSync('git config user.email "bot@workbuddy.local"', { stdio: 'ignore' })
  execSync('git config user.name "WorkBuddy Bot"', { stdio: 'ignore' })
  execSync(`git add ${CONTENT_DIR}`, { stdio: 'ignore' })
  try {
    execSync('git commit -m "chore: daily learning content ' + DATE + '"', { stdio: 'ignore' })
  } catch {
    log('无变更，无需提交')
    return
  }
  execSync(`git push`, { stdio: 'inherit' })
  log('已推送至远程')
}

main().catch((e) => {
  console.error('[gen-content] 失败', e)
  process.exit(1)
})
