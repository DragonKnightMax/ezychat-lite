// The concept-tips copy (en, ms, zh-CN) merged into src/i18n/locales/<lang>/common.json under `mockTips`.
// Round 2 (owner: "too many text"): one or two short sentences per card, steps folded behind "Show steps".
// Usage: node docs/features/ai-handoff-rules/mock/tips-copy.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const en = {
  guide: 'Full guide',
  showSteps: 'Show steps',
  hideSteps: 'Hide steps',
  whatsappLink: {
    title: 'What is a linked device?',
    body: 'EzyChat links to your WhatsApp like WhatsApp Web. Your phone keeps the number; open WhatsApp on it at least every 14 days.',
  },
  aiConnection: {
    title: 'Why connect an AI?',
    body: 'EzyChat has no AI of its own. Sign in with ChatGPT (easiest) or use an API key; that service bills you.',
  },
  apiKey: {
    title: 'What is an API key?',
    body: 'A secret code that lets EzyChat use OpenAI on your account. OpenAI bills you for what the AI uses.',
    step1: 'Sign in at platform.openai.com.',
    step2: 'Billing: add a card or credit.',
    step3: 'API keys → Create new secret key.',
    step4: 'Copy the key (sk-…) and paste it here.',
    action: 'Get a key at OpenAI',
  },
  claudeKey: {
    title: 'What is a Claude API key?',
    body: 'A secret code that lets EzyChat use Claude on your account. Anthropic bills you for what the AI uses.',
    step1: 'Sign in at console.anthropic.com.',
    step2: 'Billing: add credit.',
    step3: 'API keys → Create key.',
    step4: 'Copy the key (sk-ant-…) and paste it here.',
    action: 'Get a key at Anthropic',
  },
  aiModel: {
    title: 'What is a model?',
    body: 'The version of the AI. Bigger is smarter but slower and costs more. Keep the recommended one.',
  },
  businessContext: {
    title: 'What is Business context?',
    body: 'What the AI knows: products, prices, hours, delivery, FAQs. It answers only from this, so keep it up to date.',
  },
  instructions: {
    title: 'What is the role?',
    body: 'How the AI behaves: tone, language, what to ask. Facts like prices go in Business context.',
  },
  handoff: {
    title: 'What is a hand-over?',
    body: 'The AI stops and passes the chat to your team, who get a notification. These rules say when, e.g. complaints or refunds.',
  },
  tryIt: {
    title: 'What is Try it?',
    body: 'A practice chat to see how the AI would answer. Nothing is sent to WhatsApp.',
  },
  voice: {
    title: 'What is voice transcription?',
    body: 'Turns voice notes into text. On this computer: free and private. Cloud: faster, uses your OpenAI key.',
  },
  tunnel: {
    title: 'What is phone access?',
    body: 'A secure web address (free, through Cloudflare) so your team can open the inbox on their phones. This computer must stay on.',
  },
  lan: {
    title: 'What is LAN access?',
    body: 'Phones on the same Wi-Fi can open the inbox. Not encrypted: turn it on only on a network you trust.',
  },
  mcp: {
    title: 'What is AI assistant access?',
    body: 'Lets Claude or ChatGPT read your inbox to summarise chats or improve your AI agent. Off until you turn it on.',
  },
  accessToken: {
    title: 'What is an access token?',
    body: 'A secret code for developer tools to use your inbox. claude.ai and ChatGPT do not need one.',
  },
  connectors: {
    title: 'What is a connector?',
    body: 'Lets your AI agent use another app, for example check Google Calendar and book appointments.',
  },
};

const ms = {
  guide: 'Panduan penuh',
  showSteps: 'Tunjuk langkah',
  hideSteps: 'Sembunyi langkah',
  whatsappLink: {
    title: 'Apakah peranti dipaut?',
    body: 'EzyChat dipautkan ke WhatsApp anda seperti WhatsApp Web. Nombor kekal di telefon; buka WhatsApp di telefon sekurang-kurangnya setiap 14 hari.',
  },
  aiConnection: {
    title: 'Kenapa sambungkan AI?',
    body: 'EzyChat tiada AI sendiri. Log masuk dengan ChatGPT (paling mudah) atau guna kunci API; perkhidmatan itu yang mengebil anda.',
  },
  apiKey: {
    title: 'Apakah kunci API?',
    body: 'Kod rahsia yang membolehkan EzyChat menggunakan OpenAI pada akaun anda. OpenAI mengebil anda mengikut penggunaan AI.',
    step1: 'Log masuk di platform.openai.com.',
    step2: 'Billing: tambah kad atau kredit.',
    step3: 'API keys → Create new secret key.',
    step4: 'Salin kunci (sk-…) dan tampal di sini.',
    action: 'Dapatkan kunci di OpenAI',
  },
  claudeKey: {
    title: 'Apakah kunci API Claude?',
    body: 'Kod rahsia yang membolehkan EzyChat menggunakan Claude pada akaun anda. Anthropic mengebil anda mengikut penggunaan AI.',
    step1: 'Log masuk di console.anthropic.com.',
    step2: 'Billing: tambah kredit.',
    step3: 'API keys → Create key.',
    step4: 'Salin kunci (sk-ant-…) dan tampal di sini.',
    action: 'Dapatkan kunci di Anthropic',
  },
  aiModel: {
    title: 'Apakah model?',
    body: 'Versi AI. Lebih besar lebih pintar tetapi lebih perlahan dan mahal. Kekalkan yang disyorkan.',
  },
  businessContext: {
    title: 'Apakah Konteks perniagaan?',
    body: 'Apa yang AI tahu: produk, harga, waktu, penghantaran, soalan lazim. Ia menjawab hanya daripada ini, jadi pastikan sentiasa terkini.',
  },
  instructions: {
    title: 'Apakah peranan?',
    body: 'Cara AI berkelakuan: nada, bahasa, apa yang ditanya. Fakta seperti harga dimasukkan dalam Konteks perniagaan.',
  },
  handoff: {
    title: 'Apakah serahan?',
    body: 'AI berhenti dan menyerahkan chat kepada pasukan anda, yang menerima pemberitahuan. Peraturan ini menetapkan bila, cth. aduan atau bayaran balik.',
  },
  tryIt: {
    title: 'Apakah Cuba?',
    body: 'Chat latihan untuk melihat jawapan AI. Tiada apa dihantar ke WhatsApp.',
  },
  voice: {
    title: 'Apakah transkripsi suara?',
    body: 'Menukar nota suara kepada teks. Pada komputer ini: percuma dan peribadi. Awan: lebih pantas, guna kunci OpenAI anda.',
  },
  tunnel: {
    title: 'Apakah akses telefon?',
    body: 'Alamat web selamat (percuma, melalui Cloudflare) supaya pasukan boleh buka peti masuk di telefon. Komputer ini mesti kekal hidup.',
  },
  lan: {
    title: 'Apakah akses LAN?',
    body: 'Telefon pada Wi-Fi yang sama boleh buka peti masuk. Tidak disulitkan: hidupkan hanya pada rangkaian yang dipercayai.',
  },
  mcp: {
    title: 'Apakah akses pembantu AI?',
    body: 'Membolehkan Claude atau ChatGPT membaca peti masuk untuk meringkaskan chat atau menambah baik ejen AI. Dimatikan sehingga anda menghidupkannya.',
  },
  accessToken: {
    title: 'Apakah token akses?',
    body: 'Kod rahsia untuk alat pembangun menggunakan peti masuk anda. claude.ai dan ChatGPT tidak memerlukannya.',
  },
  connectors: {
    title: 'Apakah penyambung?',
    body: 'Membolehkan ejen AI menggunakan aplikasi lain, cth. menyemak Google Calendar dan membuat temu janji.',
  },
};

const zh = {
  guide: '完整指南',
  showSteps: '显示步骤',
  hideSteps: '隐藏步骤',
  whatsappLink: {
    title: '什么是关联设备？',
    body: 'EzyChat 像 WhatsApp Web 一样关联您的 WhatsApp。号码仍在手机上；请至少每 14 天在手机上打开一次 WhatsApp。',
  },
  aiConnection: {
    title: '为什么要连接 AI？',
    body: 'EzyChat 本身没有 AI。用 ChatGPT 登录（最简单）或使用 API 密钥；由该服务向您收费。',
  },
  apiKey: {
    title: '什么是 API 密钥？',
    body: '一串秘密代码，让 EzyChat 用您的账号使用 OpenAI。OpenAI 按 AI 用量向您收费。',
    step1: '在 platform.openai.com 登录。',
    step2: 'Billing：添加银行卡或充值。',
    step3: 'API keys → Create new secret key。',
    step4: '复制密钥（sk-…）并粘贴到这里。',
    action: '到 OpenAI 获取密钥',
  },
  claudeKey: {
    title: '什么是 Claude API 密钥？',
    body: '一串秘密代码，让 EzyChat 用您的账号使用 Claude。Anthropic 按 AI 用量向您收费。',
    step1: '在 console.anthropic.com 登录。',
    step2: 'Billing：充值。',
    step3: 'API keys → Create key。',
    step4: '复制密钥（sk-ant-…）并粘贴到这里。',
    action: '到 Anthropic 获取密钥',
  },
  aiModel: {
    title: '什么是模型？',
    body: 'AI 的版本。越大越聪明，但更慢、更贵。保留推荐的即可。',
  },
  businessContext: {
    title: '什么是业务资料？',
    body: 'AI 知道的内容：产品、价格、营业时间、送货、常见问题。AI 只根据这些回答，请保持最新。',
  },
  instructions: {
    title: '什么是角色？',
    body: 'AI 的表现方式：语气、语言、要问什么。价格等事实请放在业务资料里。',
  },
  handoff: {
    title: '什么是转交？',
    body: 'AI 停下，把聊天交给团队，团队会收到通知。这些规则决定何时转交，例如投诉或退款。',
  },
  tryIt: {
    title: '什么是“试一试”？',
    body: '练习聊天，看看 AI 会怎么回答。不会发送到 WhatsApp。',
  },
  voice: {
    title: '什么是语音转文字？',
    body: '把语音消息转成文字。在这台电脑上：免费、私密。云端：更快，使用您的 OpenAI 密钥。',
  },
  tunnel: {
    title: '什么是手机访问？',
    body: '一个安全网址（免费，通过 Cloudflare），让团队用手机打开收件箱。这台电脑必须保持开机。',
  },
  lan: {
    title: '什么是局域网访问？',
    body: '同一 Wi-Fi 的手机可以打开收件箱。不加密：只在信任的网络中开启。',
  },
  mcp: {
    title: '什么是 AI 助手访问？',
    body: '让 Claude 或 ChatGPT 读取收件箱，帮您总结聊天或改进 AI 客服。开启前一直关闭。',
  },
  accessToken: {
    title: '什么是访问令牌？',
    body: '开发工具使用收件箱的秘密代码。claude.ai 和 ChatGPT 不需要。',
  },
  connectors: {
    title: '什么是连接器？',
    body: '让 AI 客服使用其他应用，例如查看 Google 日历并预约。',
  },
};

const dir = join(import.meta.dirname, 'src', 'i18n', 'locales');
for (const [lang, copy] of [
  ['en', en],
  ['ms', ms],
  ['zh-CN', zh],
]) {
  const file = join(dir, lang, 'common.json');
  const json = JSON.parse(readFileSync(file, 'utf8'));
  json.mockTips = copy;
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}
