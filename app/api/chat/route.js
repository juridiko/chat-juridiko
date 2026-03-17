// /api/chat/route.js
// Serverless endpoint — GET + POST. Memberstack borttaget, öppen åtkomst.

const HEADERS_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Content-Type": "application/json",
};

const SYSTEM_PROMPT = `Du är en svensk juridisk AI assistent för Juridiko. Svara på alla juridiska frågor och var professionell. Du ersätter inte en advokat. Hjälp användaren med deras juridiska frågor och problem. Kommunicera inte utanför din roll. Du är expert inom svenska lagar och hur juridik påverkar människor. Du sparar ingen information och följer GDPR. Var utförlig och tydlig, gör allt för att användaren ska bli nöjd.`;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: HEADERS_CORS });
}

// GET: hämta senaste konversation för userId
export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");
    if (!userId) {
      return new Response(
        JSON.stringify({ error: "userId krävs" }),
        { status: 400, headers: HEADERS_CORS }
      );
    }

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

    return new Response(
      JSON.stringify({ conversationId, history: msgs || [] }),
      { status: 200, headers: HEADERS_CORS }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: HEADERS_CORS }
    );
  }
}

// POST: skicka meddelande
export async function POST(req) {
  try {
    const body = await req.json();
    const { userId, message, conversationId: convId } = body;

    if (!userId || !message?.trim()) {
      return new Response(
        JSON.stringify({ error: "userId och message krävs" }),
        { status: 400, headers: HEADERS_CORS }
      );
    }

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

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...((ctx || []).map((m) => ({ role: m.role, content: m.content }))),
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

    return new Response(
      JSON.stringify({ conversationId, reply, history: full || [] }),
      { status: 200, headers: HEADERS_CORS }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: HEADERS_CORS }
    );
  }
}

