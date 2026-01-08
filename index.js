const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const express = require('express');
const cors = require('cors');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
    ]
});

const app = express();
app.use(express.json());
app.use(cors());

// 환경변수
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const WORKER_API_URL = process.env.WORKER_API_URL || 'https://frostc.pages.dev';
const WORKER_SECRET = process.env.WORKER_SECRET;
const APPROVAL_CHANNEL_ID = process.env.APPROVAL_CHANNEL_ID;
const PORT = process.env.PORT || 3000;

// 관리자 계정 (공지 작성용)
const ADMIN_AUTHOR = '겁많은두더지';
const ADMIN_PASSWORD = 'luzruz555';

// 대기 중인 글 임시 저장 (메모리)
const pendingPosts = new Map();

// ═══════════════════════════════════════════
// 관리자 체크 함수
// ═══════════════════════════════════════════
function isAdmin(author, password) {
    return author === ADMIN_AUTHOR && password === ADMIN_PASSWORD;
}

// ═══════════════════════════════════════════
// Express 서버 - 글 작성 요청 수신
// ═══════════════════════════════════════════
app.post('/submit', async (req, res) => {
    try {
        const { type, title, author, content, password } = req.body;

        // 유효성 검사
        if (!type || !title || !author || !content || !password) {
            return res.status(400).json({ error: '모든 필드를 입력해주세요.' });
        }

        if (title.length > 50) {
            return res.status(400).json({ error: '제목은 50자 이내로 입력해주세요.' });
        }

        if (content.length > 2000) {
            return res.status(400).json({ error: '본문은 2000자 이내로 입력해주세요.' });
        }

        // 고유 ID 생성
        const postId = `post_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // ═══════════════════════════════════════════
        // 관리자면 자동 승인 + 공지로 등록
        // ═══════════════════════════════════════════
        if (isAdmin(author, password)) {
            try {
                const response = await fetch(`${WORKER_API_URL}/api/posts`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${WORKER_SECRET}`
                    },
                    body: JSON.stringify({
                        id: postId,
                        type: type,
                        title: title,
                        author: author,
                        content: content,
                        password: password,
                        isNotice: true,  // 공지 플래그
                        approved: true,
                        approvedAt: Date.now(),
                        approvedBy: 'ADMIN_AUTO'
                    })
                });

                if (!response.ok) {
                    throw new Error(`API 응답 오류: ${response.status}`);
                }

                // 디스코드에 알림 (선택)
                try {
                    const channel = await client.channels.fetch(APPROVAL_CHANNEL_ID);
                    const embed = new EmbedBuilder()
                        .setColor(0xFFD700) // 금색
                        .setTitle('📢 공지 자동 게시됨')
                        .addFields(
                            { name: '제목', value: title, inline: false },
                            { name: '작성자', value: author, inline: true }
                        )
                        .setFooter({ text: `ID: ${postId}` })
                        .setTimestamp();
                    await channel.send({ embeds: [embed] });
                } catch (e) {
                    console.log('Discord notification failed:', e);
                }

                return res.json({ success: true, message: '공지가 게시되었습니다.' });

            } catch (error) {
                console.error('Admin post error:', error);
                return res.status(500).json({ error: '공지 등록 중 오류가 발생했습니다.' });
            }
        }

        // ═══════════════════════════════════════════
        // 일반 유저: 디스코드 승인 요청
        // ═══════════════════════════════════════════
        const channel = await client.channels.fetch(APPROVAL_CHANNEL_ID);
        
        const embed = new EmbedBuilder()
            .setColor(0xD4743C)
            .setTitle('📝 새 글 승인 요청')
            .addFields(
                { name: '유형', value: getTypeLabel(type), inline: true },
                { name: '작성자', value: author, inline: true },
                { name: '제목', value: title, inline: false },
                { name: '본문', value: content.length > 500 ? content.substring(0, 500) + '...' : content, inline: false }
            )
            .setFooter({ text: `ID: ${postId}` })
            .setTimestamp();

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`approve_${postId}`)
                    .setLabel('승인')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('✅'),
                new ButtonBuilder()
                    .setCustomId(`reject_${postId}`)
                    .setLabel('거절')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('❌')
            );

        const message = await channel.send({ embeds: [embed], components: [row] });

        pendingPosts.set(postId, {
            type,
            title,
            author,
            content,
            password,
            isNotice: false,
            messageId: message.id,
            timestamp: Date.now()
        });

        res.json({ success: true, message: '글이 제출되었습니다. 관리자 승인을 기다려주세요.' });

    } catch (error) {
        console.error('Submit error:', error);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

// 상태 체크 (UptimeRobot용)
app.get('/', (req, res) => {
    res.send('Frost Community Bot is running!');
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// ═══════════════════════════════════════════
// 디스코드 봇 이벤트
// ═══════════════════════════════════════════
client.once('ready', () => {
    console.log(`✅ 봇 로그인: ${client.user.tag}`);
    console.log(`📡 서버 수: ${client.guilds.cache.size}`);
});

// 버튼 클릭 처리
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    const [action, postId] = interaction.customId.split('_').reduce((acc, part, i, arr) => {
        if (i === 0) return [part, arr.slice(1).join('_')];
        return acc;
    }, []);

    const postData = pendingPosts.get(postId);

    if (!postData) {
        return interaction.reply({ 
            content: '⚠️ 이 글은 이미 처리되었거나 만료되었습니다.', 
            ephemeral: true 
        });
    }

    if (action === 'approve') {
        await handleApprove(interaction, postId, postData);
    } else if (action === 'reject') {
        await handleReject(interaction, postId, postData);
    }
});

// ═══════════════════════════════════════════
// 승인/거절 처리 함수
// ═══════════════════════════════════════════
async function handleApprove(interaction, postId, postData) {
    await interaction.deferReply({ ephemeral: true });

    try {
        const response = await fetch(`${WORKER_API_URL}/api/posts`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${WORKER_SECRET}`
            },
            body: JSON.stringify({
                id: postId,
                type: postData.type,
                title: postData.title,
                author: postData.author,
                content: postData.content,
                password: postData.password,
                isNotice: false,
                approved: true,
                approvedAt: Date.now(),
                approvedBy: interaction.user.tag
            })
        });

        if (!response.ok) {
            throw new Error(`API 응답 오류: ${response.status}`);
        }

        const embed = EmbedBuilder.from(interaction.message.embeds[0])
            .setColor(0x00FF00)
            .setTitle('✅ 승인됨')
            .addFields({ name: '승인자', value: interaction.user.tag, inline: true });

        await interaction.message.edit({ embeds: [embed], components: [] });
        pendingPosts.delete(postId);
        await interaction.editReply({ content: '✅ 글이 승인되어 게시되었습니다!' });

    } catch (error) {
        console.error('Approve error:', error);
        await interaction.editReply({ content: '❌ 승인 처리 중 오류가 발생했습니다.' });
    }
}

async function handleReject(interaction, postId, postData) {
    const embed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor(0xFF0000)
        .setTitle('❌ 거절됨')
        .addFields({ name: '거절자', value: interaction.user.tag, inline: true });

    await interaction.message.edit({ embeds: [embed], components: [] });
    pendingPosts.delete(postId);

    await interaction.reply({ 
        content: '❌ 글이 거절되었습니다.', 
        ephemeral: true 
    });
}

// ═══════════════════════════════════════════
// 유틸리티 함수
// ═══════════════════════════════════════════
function getTypeLabel(type) {
    const types = {
        'free': '자유',
        'info': '정보',
        'trade': '거래',
        'help': '질문'
    };
    return types[type] || type;
}

// 오래된 대기 글 정리 (1시간 후 자동 만료)
setInterval(() => {
    const now = Date.now();
    for (const [postId, data] of pendingPosts.entries()) {
        if (now - data.timestamp > 3600000) {
            pendingPosts.delete(postId);
            console.log(`🗑️ 만료된 글 제거: ${postId}`);
        }
    }
}, 60000);

// ═══════════════════════════════════════════
// 서버 시작
// ═══════════════════════════════════════════
app.listen(PORT, () => {
    console.log(`🌐 Express 서버 시작: 포트 ${PORT}`);
});

client.login(DISCORD_TOKEN);
