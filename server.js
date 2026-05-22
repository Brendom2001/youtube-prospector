const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const { URLSearchParams } = require('url');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

console.log('[CONFIG] YOUTUBE_API_KEY:', YOUTUBE_API_KEY ? 'presente' : 'AUSENTE');
console.log('[CONFIG] OPENAI_API_KEY:', OPENAI_API_KEY ? 'presente' : 'AUSENTE');

if (!YOUTUBE_API_KEY) {
  console.error('Missing YOUTUBE_API_KEY in .env');
}
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in .env');
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function fetchWithTimeout(url, options = {}, timeout = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function concurrentMap(items, limit, mapper) {
  const results = [];
  let index = 0;

  return new Promise((resolve, reject) => {
    let active = 0;
    let finished = 0;

    function next() {
      if (finished === items.length) {
        return resolve(results);
      }
      if (active >= limit || index >= items.length) {
        return;
      }
      const currentIndex = index++;
      active += 1;
      Promise.resolve(items[currentIndex])
        .then(item => mapper(item, currentIndex))
        .then(result => {
          results[currentIndex] = result;
        })
        .catch(reject)
        .finally(() => {
          active -= 1;
          finished += 1;
          next();
        });
      next();
    }

    next();
  });
}

function parseNumber(value) {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function detectEditingPattern(metadata) {
  const text = metadata.toLowerCase();
  const simpleKeywords = [
    'vlog', 'raw', 'sem corte', 'sem edição', 'ao vivo', 'live', 'bruto', 'descontraído', 'sem cortes', 'no-cut', 'uncut'
  ];
  const goodKeywords = [
    'cinematic', 'edited', 'edição', 'profissional', 'motion', 'miniatura', 'color grading', 'montagem', 'trailer', 'teaser'
  ];

  const simpleCount = simpleKeywords.reduce((sum, keyword) => sum + (text.includes(keyword) ? 1 : 0), 0);
  const goodCount = goodKeywords.reduce((sum, keyword) => sum + (text.includes(keyword) ? 1 : 0), 0);

  if (goodCount > 0 && simpleCount === 0) {
    return 'bom';
  }
  if (simpleCount > 0 && goodCount === 0) {
    return 'simples';
  }
  if (goodCount > 0 && simpleCount > 0) {
    return 'inconsistente';
  }

  return 'simples';
}

function computeFrequencyAndConsistency(videos) {
  const now = Date.now();
  const days90 = 90 * 24 * 60 * 60 * 1000;
  const recent = videos
    .map(v => ({
      publishedAt: new Date(v.snippet.publishedAt).getTime(),
      title: v.snippet.title,
      description: v.snippet.description || ''
    }))
    .filter(item => !Number.isNaN(item.publishedAt) && item.publishedAt >= now - days90)
    .sort((a, b) => b.publishedAt - a.publishedAt);

  const uploadsLast90 = recent.length;
  const frequency = +(uploadsLast90 / 3).toFixed(1);

  const gaps = [];
  for (let i = 0; i < recent.length - 1; i += 1) {
    const gapDays = (recent[i].publishedAt - recent[i + 1].publishedAt) / (1000 * 60 * 60 * 24);
    if (gapDays >= 0) gaps.push(gapDays);
  }

  const averageGap = gaps.length > 0 ? gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length : 0;
  const consistency = uploadsLast90 < 2 || averageGap > 18 ? 'inconsistente' : 'regular';

  const metadata = recent.map(item => `${item.title} ${item.description}`).join(' ');
  const editingPattern = detectEditingPattern(metadata);

  return {
    uploadsLast90,
    frequency,
    consistency,
    editingPattern,
    badge: editingPattern === 'simples'
      ? (frequency >= 4 ? 'VOLUME ALTO' : 'EDIÇÃO SIMPLES')
      : 'INCONSISTENTE',
    patternLabel: editingPattern === 'bom'
      ? 'edição boa'
      : editingPattern === 'simples'
        ? 'edição simples'
        : 'edição inconsistente'
  };
}

function getChannelAge(publishedAt) {
  if (!publishedAt) return 0;
  const now = Date.now();
  const created = new Date(publishedAt).getTime();
  if (Number.isNaN(created)) return 0;
  const months = (now - created) / (1000 * 60 * 60 * 24 * 30);
  return months;
}

function buildYouTubeUrl(channelId) {
  return `https://www.youtube.com/channel/${channelId}`;
}

async function fetchJson(url, options = {}) {
  const response = await fetchWithTimeout(url, options, 10000);
  if (!response.ok) {
    const errorText = await response.text().catch(() => 'no body');
    const error = new Error(`HTTP ${response.status} ${response.statusText}: ${errorText}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function generateNicheVariations(niche) {
  const prompt = `Gere 3 variações de keywords similares para o nicho: "${niche}"
Retorne apenas um JSON com a chave "variations" contendo um array com 3 strings, sem numeração.
Exemplo: {"variations": ["palavra1", "palavra2", "palavra3"]}`;

  try {
    const response = await fetchJson('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-5-mini',
        temperature: 0.7,
        max_tokens: 100,
        messages: [
          {
            role: 'system',
            content: 'Você é um especialista em análise de palavras-chave. Gere variações relevantes sem explicações extras.'
          },
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    });

    const raw = response.choices?.[0]?.message?.content || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [niche];
    
    const parsed = JSON.parse(jsonMatch[0]);
    return [niche, ...(parsed.variations || [])].slice(0, 4);
  } catch (error) {
    return [niche];
  }
}

async function searchChannels(niche, language, quantity) {
  const variations = await generateNicheVariations(niche);
  const allResults = [];
  const seenIds = new Set();

  for (const keyword of variations) {
    const params = new URLSearchParams({
      key: YOUTUBE_API_KEY,
      part: 'snippet',
      q: keyword,
      type: 'channel',
      maxResults: `${quantity * 2}`
    });

    if (language === 'pt') {
      params.set('relevanceLanguage', 'pt');
      params.set('regionCode', 'BR');
    } else if (language === 'en') {
      params.set('relevanceLanguage', 'en');
    }

    try {
      const url = `https://www.googleapis.com/youtube/v3/search?${params.toString()}`;
      const data = await fetchJson(url);
      const items = data.items || [];

      for (const item of items) {
        const channelId = item.snippet?.channelId;
        if (channelId && !seenIds.has(channelId)) {
          seenIds.add(channelId);
          allResults.push(item);
        }
      }
    } catch (error) {
      console.warn(`Erro ao buscar variação "${keyword}":`, error.message);
    }
  }

  return allResults;
}

async function getChannelDetails(channelIds, language) {
  if (!channelIds.length) return [];
  const params = new URLSearchParams({
    key: YOUTUBE_API_KEY,
    part: 'snippet,statistics,contentDetails,localization',
    id: channelIds.join(',')
  });
  const url = `https://www.googleapis.com/youtube/v3/channels?${params.toString()}`;
  const data = await fetchJson(url);
  let items = data.items || [];

  if (language === 'pt') {
    items = items.filter(channel => {
      const country = channel.snippet?.country;
      const defaultLanguage = channel.localization?.defaultLanguage || '';
      const isRelevant = 
        country === 'BR' || 
        defaultLanguage === 'pt' || 
        defaultLanguage === 'pt-BR' ||
        country === 'PT';
      return isRelevant || !country;
    });
  }

  return items;
}

async function getPlaylistVideos(playlistId) {
  if (!playlistId) return [];
  const params = new URLSearchParams({
    key: YOUTUBE_API_KEY,
    part: 'snippet',
    playlistId,
    maxResults: '10'
  });
  const url = `https://www.googleapis.com/youtube/v3/playlistItems?${params.toString()}`;
  try {
    const data = await fetchJson(url);
    return data.items || [];
  } catch (error) {
    if (error.status === 404) {
      return [];
    }
    throw error;
  }
}

function sizeMatches(count, size) {
  if (!count) return false;
  if (size === 'nano') return count >= 1000 && count < 10000;
  if (size === 'micro') return count >= 10000 && count < 50000;
  if (size === 'pequeno') return count >= 50000 && count < 100000;
  if (size === 'medio') return count >= 100000 && count < 500000;
  if (size === 'grande') return count >= 500000 && count < 1000000;
  if (size === 'mega') return count >= 1000000;
  return true;
}

async function generateOpenAIAnalysis(item, niche) {
  const prompt = `Nome do canal: ${item.title}
Nicho: ${niche}
Inscritos: ${item.subscribers}
Frequência de upload: ${item.frequency} vídeos/mês
Padrão de edição detectado: ${item.patternLabel}

Responda apenas com JSON válido com as chaves score, justificativa e mensagem.
score deve ser um número inteiro de 1 a 10.
justificativa curta.
mensagem deve ter no máximo 4 linhas, começar com Oi ou Olá + nome do canal, mencionar nicho, frequência ou tamanho, apresentar consequência de não ter boa edição e terminar com pergunta aberta sobre como está lidando com a edição hoje. Use português brasileiro informal.
Sem markdown, sem texto extra.`;

  const payload = {
    model: 'gpt-5-mini',
    temperature: 0.7,
    max_tokens: 240,
    messages: [
      {
        role: 'system',
        content: 'Você é um especialista em outreach para criadores de conteúdo no YouTube. Escreve mensagens que parecem 100% humanas, diretas e que geram resposta.'
      },
      {
        role: 'user',
        content: prompt
      }
    ]
  };

  try {
    const response = await fetchJson('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    const raw = response.choices?.[0]?.message?.content || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      console.warn('[OPENAI] Formato inesperado recebido, usando fallback');
      throw new Error('OpenAI retornou formato inesperado');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      score: parseNumber(parsed.score) || 5,
      justification: parsed.justificativa || parsed.justification || '',
      message: parsed.mensagem || parsed.message || ''
    };
  } catch (error) {
    console.error('[OPENAI ERROR]', error.message);
    throw error;
  }
}

app.post('/api/search', async (req, res) => {
  try {
    const { niche, language, size, quantity } = req.body || {};
    if (!niche || typeof niche !== 'string' || niche.trim().length < 2) {
      return res.status(400).json({ error: 'Informe um nicho válido.' });
    }

    const q = clamp(parseNumber(quantity) || 10, 5, 20);
    const langCode = language === 'en' ? 'en' : 'pt';
    const sizeKey = ['micro', 'medio', 'grande'].includes(size) ? size : 'micro';

    const searchResults = await searchChannels(niche.trim(), langCode, q * 3);
    const channelIds = searchResults.map(item => item.snippet.channelId).filter(Boolean);
    const details = await getChannelDetails(channelIds, langCode);

    const candidates = await concurrentMap(details, 4, async channel => {
      let playlistId = channel.contentDetails?.relatedPlaylists?.uploads;
      if (!playlistId && channel.id) {
        playlistId = 'UU' + channel.id.substring(2);
      }
      const videos = await getPlaylistVideos(playlistId);
      const analysis = computeFrequencyAndConsistency(videos);

      const subscribers = parseNumber(channel.statistics?.subscriberCount);
      const views = parseNumber(channel.statistics?.viewCount);
      const videoCount = parseNumber(channel.statistics?.videoCount);
      const publishedAt = channel.snippet?.publishedAt;
      const channelAge = getChannelAge(publishedAt);

      const channelInfo = {
        id: channel.id,
        title: channel.snippet?.title || 'Canal sem nome',
        description: channel.snippet?.description || '',
        thumbnail: channel.snippet?.thumbnails?.high?.url || channel.snippet?.thumbnails?.default?.url || '',
        subscribers,
        views,
        videoCount,
        channelAge,
        country: channel.snippet?.country || 'N/A',
        ...analysis,
        channelUrl: buildYouTubeUrl(channel.id)
      };

      return channelInfo;
    });

    const filtered = candidates
      .filter(item => item.frequency >= 2)
      .filter(item => item.videoCount >= 10)
      .filter(item => item.channelAge >= 6)
      .filter(item => ['EDIÇÃO SIMPLES', 'INCONSISTENTE', 'VOLUME ALTO'].includes(item.badge))
      .filter(item => sizeMatches(item.subscribers, sizeKey))
      .slice(0, q);

    if (filtered.length === 0 && candidates.length > 0) {
      const fallback = candidates
        .filter(item => item.videoCount >= 5)
        .filter(item => ['EDIÇÃO SIMPLES', 'INCONSISTENTE', 'VOLUME ALTO'].includes(item.badge))
        .slice(0, q);
      if (fallback.length > 0) {
        filtered.push(...fallback);
      }
    }

    const qualified = await concurrentMap(filtered, 3, async item => {
      try {
        const analysis = await generateOpenAIAnalysis(item, niche.trim());
        return {
          ...item,
          score: clamp(analysis.score, 1, 10),
          justification: analysis.justification,
          approachMessage: analysis.message
        };
      } catch (error) {
        console.error(`[ANALYSIS ERROR] ${item.title}:`, error.message);
        return {
          ...item,
          score: 5,
          justification: 'Análise em progresso.',
          approachMessage: `Oi ${item.title}, vi seu canal de ${niche} com frequência de ${item.frequency} vídeos/mês e edição aparente ${item.patternLabel}. Como você está lidando com a edição hoje?`
        };
      }
    });

    qualified.sort((a, b) => b.score - a.score);

    return res.json({ results: qualified });
  } catch (error) {
    console.error(error);
    const status = error.status === 429 || error.status === 403 ? 429 : 500;
    return res.status(status).json({ error: error.message || 'Erro interno no servidor.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
