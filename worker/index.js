const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS });
    }

    const url = new URL(request.url);

    // ── /image endpoint: image only ──────────────────────────────────────────
    if (url.pathname === '/image') {
      try {
        const { topic, scripture } = await request.json();
        const image = await generateBiblicalImage(env, { topic, scripture });
        return new Response(
          JSON.stringify({ image }),
          { headers: { ...CORS, 'Content-Type': 'application/json' } }
        );
      } catch (err) {
        console.error(err);
        return new Response(
          JSON.stringify({ image: null, error: err.message }),
          { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
        );
      }
    }

    // ── Default endpoint: sermon text only ──────────────────────────────────
    try {
      const { topic, scripture, tone, length, notes } = await request.json();
      const { text, scripture: resolvedScripture } = await generateSermon(env, { topic, scripture, tone, length, notes });
      return new Response(
        JSON.stringify({ text, scripture: resolvedScripture }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    } catch (err) {
      console.error(err);
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }
  }
};

// ── Sermon generation (Claude) ──────────────────────────────────────────────
async function generateSermon(env, { topic, scripture, tone, length, notes }) {
  const wordCount = Math.round(parseInt(length || 20) * 130);
  const needsScripture = !scripture || /find|for me/i.test(scripture.trim());

  const systemPrompt = `You are an experienced pastor and theologian who crafts compelling, biblically-grounded sermons. Write sermons that are spiritually rich, practically applicable, and appropriate for Sunday morning worship.`;

  const userPrompt = `Write a complete ${length}-minute sermon (approximately ${wordCount} words) on the topic: "${topic}"
${needsScripture ? 'Choose the most fitting scripture passage for this topic.' : `Primary Scripture: ${scripture}`}
Tone: ${tone}
${notes ? `Additional context: ${notes}` : ''}

${needsScripture ? 'Start your ENTIRE response with this line (no other text before it):\nSCRIPTURE: [the exact reference you chose, e.g. Romans 8:28]\n\n' : ''}Structure the sermon with:
- A compelling title
- An engaging introduction that connects with the congregation
- 3 main points, each with biblical support
- Practical application for each point
- A powerful conclusion with a call to action

Format the sermon clearly with headers for each section.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error: ${err}`);
  }

  const data = await response.json();
  const raw = data.content?.[0]?.text || '';

  // Extract scripture reference if Claude chose one
  let chosenScripture = scripture || '';
  let sermonText = raw;
  if (needsScripture) {
    const match = raw.match(/^SCRIPTURE:\s*(.+)/m);
    if (match) {
      chosenScripture = match[1].trim();
      sermonText = raw.replace(/^SCRIPTURE:\s*.+\n?/, '').trimStart();
    }
  }

  return { text: sermonText, scripture: chosenScripture };
}

// ── Biblical image generation (Cloudflare Workers AI) ───────────────────────
async function generateBiblicalImage(env, { topic, scripture }) {
  const scenePrompt = buildBiblicalImagePrompt(topic, scripture);

  try {
    const response = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', {
      prompt: scenePrompt,
      seed: Math.floor(Math.random() * 10000),
    });

    // flux-1-schnell returns { image: base64String }
    if (!response?.image) return null;
    return `data:image/jpeg;base64,${response.image}`;

  } catch (err) {
    console.error('Image generation failed:', err);
    return null;
  }
}

// ── Build a vivid biblical image prompt ─────────────────────────────────────
function buildBiblicalImagePrompt(topic, scripture) {
  const topicLower = (topic || '').toLowerCase();
  const scriptureRef = scripture || '';

  const sceneMap = [
    { keys: ['faith', 'trust', 'doubt'], scene: 'Jesus walking on water extending his hand to Peter in a stormy sea at night' },
    { keys: ['prayer', 'pray'], scene: 'Jesus kneeling alone in the Garden of Gethsemane praying under olive trees in moonlight' },
    { keys: ['love', 'grace', 'mercy', 'forgiveness'], scene: 'the parable of the prodigal son father embracing his returning son on a dusty road at sunset' },
    { keys: ['hope', 'light', 'darkness'], scene: 'dawn breaking over the empty tomb of Jesus with golden light streaming through the entrance' },
    { keys: ['shepherd', 'sheep', 'psalm 23'], scene: 'Jesus the Good Shepherd carrying a lamb on his shoulders in green hills at golden hour' },
    { keys: ['sermon on the mount', 'beatitude', 'kingdom'], scene: 'Jesus teaching the Sermon on the Mount to a large crowd on a hillside in ancient Galilee' },
    { keys: ['salvation', 'cross', 'crucifixion', 'resurrection'], scene: 'three crosses on Golgotha hill silhouetted against a dramatic sunset sky' },
    { keys: ['bread', 'communion', 'last supper'], scene: 'the Last Supper with Jesus and his disciples at a long table bathed in warm candlelight' },
    { keys: ['baptism', 'water', 'born again'], scene: 'John baptizing Jesus in the Jordan River with a dove descending from a golden sky' },
    { keys: ['temptation', 'desert', 'wilderness'], scene: 'Jesus standing alone in the Judean wilderness under a vast starry sky praying' },
    { keys: ['miracle', 'healing', 'blind', 'sick'], scene: 'Jesus healing a blind man in an ancient Jerusalem street surrounded by amazed onlookers' },
    { keys: ['storm', 'peace', 'still'], scene: 'Jesus calming the storm on the Sea of Galilee with hands raised, waves receding' },
    { keys: ['holy spirit', 'pentecost', 'fire'], scene: 'flames of the Holy Spirit descending on disciples gathered in an upper room at Pentecost' },
    { keys: ['creation', 'genesis', 'beginning'], scene: 'dramatic creation of light over the primordial deep, golden rays piercing darkness over still waters' },
    { keys: ['david', 'goliath', 'giant', 'courage'], scene: 'young David standing victorious before the giant Goliath on an ancient battlefield' },
    { keys: ['moses', 'exodus', 'red sea', 'burning bush'], scene: 'Moses parting the Red Sea with his staff, walls of water rising on both sides' },
    { keys: ['daniel', 'lion'], scene: 'Daniel kneeling in prayer in the lions den, peaceful amid the lions, with light streaming from above' },
    { keys: ['jonah', 'whale'], scene: 'Jonah being cast from a whale onto a rocky shore with dramatic stormy skies' },
    { keys: ['noah', 'ark', 'flood'], scene: 'Noahs Ark on a calm sea after the storm with a rainbow arcing across the sky' },
    { keys: ['abraham', 'isaac', 'sacrifice'], scene: 'Abraham and Isaac on Mount Moriah with an angel appearing in a beam of light' },
  ];

  for (const { keys, scene } of sceneMap) {
    if (keys.some(k => topicLower.includes(k) || scriptureRef.toLowerCase().includes(k))) {
      return `${scene}, oil painting style, highly detailed, dramatic biblical lighting, masterpiece quality, cinematic composition, photorealistic`;
    }
  }

  return `A dramatic biblical scene representing "${topic}", ancient Holy Land setting, golden hour lighting, oil painting style, highly detailed, cinematic composition, masterpiece quality, photorealistic`;
}
