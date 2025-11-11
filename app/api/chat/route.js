// /api/chat.js
// Serverless endpoint — GET + POST. Verifierar Memberstack token via Admin REST API.

const HEADERS_CORS = {
  "Access-Control-Allow-Origin": "*", // i produktion: byt till din domän
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, x-memberstack-token",
  "Access-Control-Allow-Credentials": "true",
  "Content-Type": "application/json",
};

const SYSTEM_PROMPT = `Du är en svensk juridisk AI assistent för Juridiko. Svara på alla juridisko frågor och var professionell. Du ersätter inte en advokat. Lös användaren med deras juridiska frågor och problem. Kommunicera inte utanför din roll. Du är expert inom svenska lagar och hur juridik påverkar människor. Du sparar ingen information och följer GDPR. Va utförlig och tydlig, gör allt för att användaren ska bli nöjd.`;

const MEMBERSTACK_VERIFY_URL = "https://admin.memberstack.com/members/verify-token?token=";
const MEMBERSTACK_SECRET_ENV = "MEMBERSTACK_SECRET_KEY"; // set this env var in Vercel
// Supabase / OpenAI env names (behåll som du hade)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Simple fetch wrapper for Supabase-like operations using REST is not included here.
// We'll use fetch to call Supabase REST endpoints (REST requires anon key etc),
// but since you likely already have server-side supabase client in your repo, replace below
// with your existing Supabase client usage if needed. For clarity I use SQL via Supabase JS
// is simpler — but if you can't install npm packages, please keep your existing supabase setup.
// --- For now: assume your current repo uses createClient (server-side). If you need a pure fetch implementation,
// I can adapt — säg till. ---

// If your repo already has server-side supabase client, keep using it. Below is an example using fetch to call
// Supabase REST endpoints would be more complex. If you have existing `createClient` in repo, reuse it.

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Helper: return CORS preflight
export async function OPTIONS() {
  return new Response(null, { status: 200, headers: HEADERS_CORS });
}

// Helper: verify member token with Memberstack Admin REST verify endpoint.
// We expect the frontend to send header "x-memberstack-token" with the member token (JWT / cookie value).
async function verifyMemberToken(req) {
  try {
    const tokenHeader = req.headers.get("x-memberstack-token") || "";
    if (!tokenHeader) return { ok: false, reason: "Ingen member token skickad" };

    const secretKey = process.env[MEMBERSTACK_SECRET_ENV];
    if (!secretKey) return { ok: false, reason: "Server saknar MEMBERSTACK_SECRET_KEY (env var)" };

    // call Memberstack admin verify endpoint (GET)
    const verifyRes = await fetch(MEMBERSTACK_VERIFY_URL + encodeURIComponent(tokenHeader), {
      method: "GET",
      headers: {
        "x-api-key": secretKey, // Memberstack docs: use x-api-key header to supply secret
        "Accept": "application/json",
      },
    });

    if (!verifyRes.ok) {
      const txt = await verifyRes.text();
      return { ok: false, reason: "Memberstack verify failed: " + txt };
    }

    const json = await verifyRes.json();
    // Memberstack returns { data: { ...payload... } } when success (docs vary)
    const payload = json?.data || json?.payload || json;
    if (!payload || !payload.id) {
      return { ok: false, reason: "Token kunde inte verifieras (no member data)" };
    }

    // Retrieve member details (Memberstack Admin REST can return member's plan connections)
    // Some verify endpoints already include planConnections — check json structure
    // If verify response doesn't include plan connections, you can fetch member endpoint:
    // GET https://admin.memberstack.com/members/{id}
    let member = payload;
    if (!payload.planConnections && payload.id) {
      // fetch full member
      const mRes = await fetch(`https://admin.memberstack.com/members/${encodeURIComponent(payload.id)}`, {
        method: "GET",
        headers: {
          "x-api-key": secretKey,
          "Accept": "application/json",
        },
      });
      const mJson = await mRes.json();
      member = mJson?.data || mJson;
    }

    // Check planConnections
    const planConnections = member.planConnections || member.plan_connections || [];
    const proPlanId = "pln_juridiko-pro-ckbw0xts";
    const hasPro = planConnections.some(pc => {
      const id = pc.planId || pc.plan_id || pc.plan || "";
      const status = (pc.status || "").toUpperCase();
      return (id === proPlanId || id === "juridiko-pro") && (status === "ACTIVE" || status === "active" || status === "");
    });

    if (!hasPro) return { ok: false, reason: "Medlem saknar PRO-plan" };

    return { ok: true, member, memberId: payload.id };
  } catch (err) {
    return { ok: false, reason: "Verifieringsfel: " + err.message };
  }
}

// GET: hämta senaste konversation för userId (kan validera PRO)
export async function GET(req) {
  try {
    // Optional: require PRO for GET as well
    const verify = await verifyMemberToken(req);
    if (!verify.ok) {
      return new Response(JSON.stringify({ error: verify.reason }), { status: 401, headers: HEADERS_CORS });
    }

    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");
    if (!userId) return new Response(JSON.stringify({ error: "userId krävs" }), { status: 400, headers: HEADERS_CORS });

    const { data: convs } = await supabase
      .from("conversations")
      .select("id")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1);

    let conversationId = convs?.[0]?.id;

    if (!conversationId) {
      const { data: created, error } = await supabase
        .from("conversations")
        .insert({ user_id: userId })
        .select("id")
        .single();
      if (error) throw error;
      conversationId = created.id;
    }

    const { data: msgs } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    return new Response(JSON.stringify({ conversationId, history: msgs || [] }), { status: 200, headers: HEADERS_CORS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: HEADERS_CORS });
  }
}

// POST: skicka meddelande — verifiera PRO först
export async function POST(req) {
  try {
    const verify = await verifyMemberToken(req);
    if (!verify.ok) {
      return new Response(JSON.stringify({ error: verify.reason }), { status: 401, headers: HEADERS_CORS });
    }

    const body = await req.json();
    const { userId, message, conversationId: convId } = body;
    if (!userId || !message?.trim()) return new Response(JSON.stringify({ error: "userId och message krävs" }), { status: 400, headers: HEADERS_CORS });

    let conversationId = convId;

    if (!conversationId || conversationId.startsWith("local_")) {
      const { data: created, error } = await supabase
        .from("conversations")
        .insert({ user_id: userId })
        .select("id")
        .single();
      if (error) throw error;
      conversationId = created.id;
    }

    await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: "user",
      content: message,
    });

    const { data: ctx } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(30);

    // Call OpenAI
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...((ctx || []).map(m => ({ role: m.role, content: m.content }))),
      ],
    });

    const reply = completion.choices?.[0]?.message?.content || "Inget svar.";

    await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: reply,
    });

    const { data: full } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    return new Response(JSON.stringify({ conversationId, reply, history: full || [] }), { status: 200, headers: HEADERS_CORS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: HEADERS_CORS });
  }
}
