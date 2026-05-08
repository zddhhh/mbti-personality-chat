export async function onRequestPost(context) {
  const API_KEY = context.env.DASHSCOPE_API_KEY;
  if (!API_KEY) {
    return new Response(JSON.stringify({ error: 'API Key not configured' }), {
      status: 500,
      headers: corsHeaders('application/json'),
    });
  }

  try {
    const { prompt } = await context.request.json();
    if (!prompt) {
      return new Response(JSON.stringify({ error: 'prompt is required' }), {
        status: 400,
        headers: corsHeaders('application/json'),
      });
    }

    const response = await fetch(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model: 'wan2.6-t2i',
          input: {
            messages: [{ role: 'user', content: [{ text: prompt }] }],
          },
          parameters: {
            size: '1280*1280',
            n: 1,
            prompt_extend: false,
            watermark: false,
            negative_prompt: '低分辨率，低画质，肢体畸形，手指畸形，过饱和，蜡像感，人脸无细节，过度光滑，AI感，文字，水印，logo',
          },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      return new Response(errText, { status: response.status, headers: corsHeaders() });
    }

    const data = await response.json();

    const imageUrl =
      data?.output?.choices?.[0]?.message?.content?.[0]?.image ||
      data?.output?.results?.[0]?.url ||
      null;

    if (!imageUrl) {
      return new Response(JSON.stringify({ error: 'No image generated', raw: data }), {
        status: 500,
        headers: corsHeaders('application/json'),
      });
    }

    // Fetch the image and convert to base64 (URL expires in 24h)
    const imgResp = await fetch(imageUrl);
    if (!imgResp.ok) {
      return new Response(JSON.stringify({ url: imageUrl }), {
        headers: corsHeaders('application/json'),
      });
    }

    const arrayBuffer = await imgResp.arrayBuffer();
    const base64 = btoa(
      new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
    );
    const dataUrl = `data:image/png;base64,${base64}`;

    return new Response(JSON.stringify({ url: dataUrl }), {
      headers: corsHeaders('application/json'),
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: corsHeaders('application/json'),
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function corsHeaders(contentType) {
  const h = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (contentType) h['Content-Type'] = contentType;
  return h;
}
