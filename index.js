const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const express = require('express');

const app = express();
app.use(express.json());

// CORS 설정
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

// 환경변수
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const APPROVAL_CHANNEL_ID = process.env.APPROVAL_CHANNEL_ID;
const WORKER_API_URL = process.env.WORKER_API_URL || 'https://frostc.pages.dev';
const WORKER_SECRET = process.env.WORKER_SECRET;
const PORT = process.env.PORT || 10000;

// 관리자 계정
const ADMIN_AUTHOR = '겁많은두더지';
const ADMIN_PASSWORD = 'luzruz555';

// 대기 중인 글 저장
const pendingPosts = new Map();

// ============ Express 라우트 ============

// 헬스 체크
app.get('/', (req, res) => res.send('Bot is running'));
app.get('/health', (req, res) => res.json({ status: 'ok', pending: pendingPosts.size }));

// 글 제출
app.post('/submit', async (req, res) => {
    console.log('[SUBMIT] 요청 받음:', req.body.title);
    
    try {
        const { type, title, author, content, password } = req.body;

        // 유효성 검사
        if (!type || !title || !author || !content || !password) {
            console.log('[SUBMIT] 유효성 실패: 필드 누락');
            return res.status(400).json({ error: '모든 필드를 입력해주세요.' });
        }

        const postId = `post_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        console.log('[SUBMIT] 생성된 ID:', postId);

        // 관리자면 바로 게시
        if (author === ADMIN_AUTHOR && password === ADMIN_PASSWORD) {
            console.log('[SUBMIT] 관리자 글 - 자동 승인');
            const result = await savePost(postId, { type, title, author, content, password, isNotice: true });
            if (result.success) {
                return res.json({ success: true, message: '공지가 게시되었습니다.' });
            } else {
                return res.status(500).json({ error: result.error });
            }
        }

        // 일반 유저 - Discord 승인 요청
        const postData = { type, title, author, content, password, isNotice: false };
        pendingPosts.set(postId, postData);
        console.log('[SUBMIT] 대기열 추가, 현재 대기:', pendingPosts.size);

        // Discord에 메시지 보내기
        try {
            const channel = await client.channels.fetch(APPROVAL_CHANNEL_ID);
            
            const embed = new EmbedBuilder()
                .setColor(0xD4743C)
                .setTitle('📝 새 글 승인 요청')
                .addFields(
                    { name: '유형', value: getTypeLabel(type), inline: true },
                    { name: '작성자', value: author, inline: true },
                    { name: '🔑 비밀번호', value: `\`${password}\``, inline: true },
                    { name: '제목', value: title.substring(0, 100), inline: false },
                    { name: '본문 미리보기', value: content.substring(0, 300) + (content.length > 300 ? '...' : ''), inline: false }
                )
                .setFooter({ text: `ID: ${postId}` })
                .setTimestamp();

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`approve_${postId}`)
                        .setLabel('승인')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`reject_${postId}`)
                        .setLabel('거절')
                        .setStyle(ButtonStyle.Danger)
                );

            await channel.send({ embeds: [embed], components: [row] });
            console.log('[SUBMIT] Discord 메시지 전송 완료');
            
            return res.json({ success: true, message: '글이 제출되었습니다. 관리자 승인을 기다려주세요.' });
            
        } catch (discordError) {
            console.error('[SUBMIT] Discord 오류:', discordError.message);
            pendingPosts.delete(postId);
            return res.status(500).json({ error: 'Discord 연결 실패' });
        }

    } catch (error) {
        console.error('[SUBMIT] 오류:', error.message);
        return res.status(500).json({ error: '서버 오류' });
    }
});

// ============ API 호출 ============

async function savePost(postId, postData) {
    console.log('[API] 글 저장 시도:', postId);
    
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
                isNotice: postData.isNotice
            })
        });

        const result = await response.json();
        console.log('[API] 응답:', response.status, result);
        
        if (response.ok) {
            return { success: true };
        } else {
            return { success: false, error: result.error || 'API 오류' };
        }
    } catch (error) {
        console.error('[API] 오류:', error.message);
        return { success: false, error: error.message };
    }
}

// ============ Discord 이벤트 ============

client.once('ready', () => {
    console.log(`[DISCORD] 로그인: ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    const [action, ...idParts] = interaction.customId.split('_');
    const postId = idParts.join('_');
    
    console.log(`[BUTTON] ${action} - ${postId}`);

    if (action === 'approve') {
        await handleApprove(interaction, postId);
    } else if (action === 'reject') {
        await handleReject(interaction, postId);
    } else if (action === 'retry') {
        await handleRetry(interaction, postId);
    }
});

async function handleApprove(interaction, postId) {
    await interaction.deferUpdate();
    
    const postData = pendingPosts.get(postId);
    
    if (!postData) {
        // embed에서 복구 시도
        const embed = interaction.message.embeds[0];
        if (embed) {
            const restored = restoreFromEmbed(embed, postId);
            if (restored) {
                pendingPosts.set(postId, restored);
            }
        }
    }
    
    const data = pendingPosts.get(postId);
    
    if (!data) {
        const retryRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`retry_${postId}`)
                    .setLabel('재시도')
                    .setStyle(ButtonStyle.Primary)
            );
        await interaction.editReply({ components: [retryRow] });
        return interaction.followUp({ content: '❌ 글 데이터를 찾을 수 없습니다.', ephemeral: true });
    }

    const result = await savePost(postId, data);
    
    if (result.success) {
        pendingPosts.delete(postId);
        
        const successEmbed = EmbedBuilder.from(interaction.message.embeds[0])
            .setColor(0x00FF00)
            .setTitle('✅ 승인 완료');
        
        const retryRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`retry_${postId}`)
                    .setLabel('재업로드')
                    .setStyle(ButtonStyle.Secondary)
            );
        
        await interaction.editReply({ embeds: [successEmbed], components: [retryRow] });
        await interaction.followUp({ content: '✅ 글이 승인되어 게시되었습니다!', ephemeral: true });
    } else {
        const retryRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`approve_${postId}`)
                    .setLabel('승인')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`reject_${postId}`)
                    .setLabel('거절')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId(`retry_${postId}`)
                    .setLabel('재시도')
                    .setStyle(ButtonStyle.Primary)
            );
        await interaction.editReply({ components: [retryRow] });
        await interaction.followUp({ content: `❌ 저장 실패: ${result.error}`, ephemeral: true });
    }
}

async function handleReject(interaction, postId) {
    await interaction.deferUpdate();
    
    pendingPosts.delete(postId);
    
    const rejectEmbed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor(0xFF0000)
        .setTitle('❌ 거절됨');
    
    await interaction.editReply({ embeds: [rejectEmbed], components: [] });
    await interaction.followUp({ content: '❌ 글이 거절되었습니다.', ephemeral: true });
}

async function handleRetry(interaction, postId) {
    await interaction.deferUpdate();
    
    let postData = pendingPosts.get(postId);
    
    if (!postData) {
        const embed = interaction.message.embeds[0];
        if (embed) {
            postData = restoreFromEmbed(embed, postId);
            if (postData) {
                pendingPosts.set(postId, postData);
            }
        }
    }
    
    if (!postData) {
        return interaction.followUp({ content: '❌ 글 데이터를 복구할 수 없습니다.', ephemeral: true });
    }
    
    const result = await savePost(postId, postData);
    
    if (result.success) {
        const successEmbed = EmbedBuilder.from(interaction.message.embeds[0])
            .setColor(0x00FF00)
            .setTitle('✅ 재업로드 완료');
        
        await interaction.editReply({ embeds: [successEmbed] });
        await interaction.followUp({ content: '✅ 재업로드 완료!', ephemeral: true });
    } else {
        await interaction.followUp({ content: `❌ 재업로드 실패: ${result.error}`, ephemeral: true });
    }
}

function restoreFromEmbed(embed, postId) {
    try {
        const fields = embed.fields || [];
        let type = 'free', author = '', title = '', content = '', password = '';
        
        fields.forEach(f => {
            if (f.name === '유형') {
                const typeMap = { '자유': 'free', '정보': 'info', '거래': 'trade', '질문': 'help' };
                type = typeMap[f.value] || 'free';
            }
            if (f.name === '작성자') author = f.value;
            if (f.name === '제목') title = f.value;
            if (f.name === '본문 미리보기') content = f.value.replace('...', '');
            if (f.name === '🔑 비밀번호') password = f.value.replace(/`/g, '');
        });
        
        if (author && title && content && password) {
            return { type, title, author, content, password, isNotice: false };
        }
        return null;
    } catch (e) {
        console.error('[RESTORE] 오류:', e.message);
        return null;
    }
}

function getTypeLabel(type) {
    const labels = { free: '자유', info: '정보', trade: '거래', help: '질문' };
    return labels[type] || type;
}

// ============ 시작 ============

app.listen(PORT, () => {
    console.log(`[EXPRESS] 서버 시작: 포트 ${PORT}`);
});

client.login(DISCORD_TOKEN).catch(err => {
    console.error('[DISCORD] 로그인 실패:', err.message);
});
