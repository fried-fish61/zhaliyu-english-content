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
const DATE = new Date().toISOString().slice(0, 10)

function log(...a) { console.log('[gen-content]', ...a) }

async function callLLM(system, user) {
  if (!API_KEY) {
    console.error('[gen-content] 未配置 LLM_API_KEY，跳过生成')
    process.exit(0)
  }
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 1,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
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

  // 1) 单词：法律/合规/通用商务英语主题，10 个
  if (!exists.has(`words_${DATE}`)) {
    const words = await callLLM(
      '你是英语词汇教学助手。只输出 JSON，不要任何额外文字。结构：{"theme":"中文主题","theme_en":"英文主题","words":[{"term":"英文单词","ipa":"音标","cn_meaning":"中文释义","collins_def":"英文权威释义","pron_tip":"发音/记忆提示（可选）","examples":[{"en":"英文例句","cn":"例句中文"}]}]}。主题为当天精选，围绕法律合规、商业、职场常用词，难度中等偏上。',
      `请为 ${DATE} 生成 10 个值得学习的英文单词（避免与常见小学词汇重复），适合中国法律/合规从业者。`
    )
    const out = { theme: words.theme, theme_en: words.theme_en, words: (words.words || []).slice(0, 10) }
    writeFileSync(`${CONTENT_DIR}/words/${DATE}.json`, JSON.stringify(out, null, 2))
    manifest.push({ type: 'words', date: DATE, file: `words/${DATE}.json` })
    log('已生成单词', out.words.length)
  }

  // 2) 文章：1 篇，含正文段落 + 核心词汇 + 长难句（body 末尾混合，前端会自动切分）
  if (!exists.has(`articles_${DATE}`)) {
    const art = await callLLM(
      '你是英文阅读教学作者。只输出 JSON，不要任何额外文字。结构：{"articles":[{"title":"标题","body":["第1段正文","第2段正文","1. **单词** — 英文释义","1. \"原句\"","- 主句：拆解","- 从句：拆解"]}]}。body 是字符串数组：前几段为正文，之后可追加「1. **词汇** — 释义」与「1. \"原句\"」+「- 标签：内容」形式的拆解（前端会自动切分）。主题围绕法律合规/商业/科技，长度适中（约 250-400 词）。',
      `请为 ${DATE} 生成 1 篇英文阅读素材，难度中上，主题可选「数据合规」「反洗钱」「公司治理」等。`
    )
    const data = { articles: (art.articles || []).slice(0, 2) }
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
