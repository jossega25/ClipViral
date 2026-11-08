import { GoogleGenAI } from "https://esm.run/@google/genai";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonResponse = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Método no permitido." }, 405);
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return jsonResponse({ error: "El cuerpo de la solicitud debe ser JSON válido." }, 400);
  }
  if (typeof input !== "object" || input === null) {
    return jsonResponse({ error: "El cuerpo de la solicitud debe ser un objeto JSON." }, 400);
  }

  const transcript = "transcript" in input && typeof input.transcript === "string"
    ? input.transcript.trim()
    : "";
  const title = "title" in input && typeof input.title === "string"
    ? input.title.trim().slice(0, 200)
    : "";

  if (!transcript || transcript.length > 50000) {
    return jsonResponse({ error: "La transcripción debe tener entre 1 y 50000 caracteres." }, 400);
  }

  const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const supabaseSecretKey = Deno.env.get("SUPABASE_SECRET_KEY");
  const authorization = request.headers.get("Authorization");
  if (!geminiApiKey || !supabaseUrl || !supabaseAnonKey || !supabaseSecretKey) {
    console.error("Faltan GEMINI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY o SUPABASE_SECRET_KEY en la configuración de la función.");
    return jsonResponse({ error: "El servicio de análisis no está configurado." }, 500);
  }
  if (!authorization?.startsWith("Bearer ")) {
    return jsonResponse({ error: "Debes iniciar sesión para analizar una transcripción." }, 401);
  }

  try {
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authorization } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return jsonResponse({ error: "La sesión no es válida o ha caducado. Inicia sesión de nuevo." }, 401);
    }

    const ai = new GoogleGenAI({ apiKey: geminiApiKey });
    const generated = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `Analiza la siguiente transcripción para estimar su potencial de viralidad en redes sociales. Devuelve únicamente un JSON válido, sin markdown, con exactamente estas propiedades: "virality_score" (entero de 0 a 100), "virality_reason" (explicación breve en español) y "hooks" (array de exactamente 3 ganchos breves en español).

Transcripción:
${transcript}`,
      config: { responseMimeType: "application/json" },
    });

    if (!generated.text) {
      throw new Error("Gemini devolvió una respuesta vacía.");
    }

    const analysis: unknown = JSON.parse(generated.text);
    if (
      typeof analysis !== "object" ||
      analysis === null ||
      !("virality_score" in analysis) ||
      !("virality_reason" in analysis) ||
      !("hooks" in analysis)
    ) {
      throw new Error("Gemini devolvió un JSON con una estructura incorrecta.");
    }

    const { virality_score, virality_reason, hooks } = analysis;
    if (
      typeof virality_score !== "number" ||
      !Number.isInteger(virality_score) ||
      virality_score < 0 ||
      virality_score > 100 ||
      typeof virality_reason !== "string" ||
      !virality_reason.trim() ||
      !isStringArray(hooks) ||
      hooks.length !== 3 ||
      !hooks.every((hook) => hook.trim())
    ) {
      throw new Error("Gemini devolvió valores fuera del formato requerido.");
    }

    const videoTitle = title || transcript.slice(0, 80);
    const supabase = createClient(supabaseUrl, supabaseSecretKey);
    const { data: saved, error: insertError } = await supabase
      .from("videos_analizados")
      .insert({
        titulo: videoTitle,
        virality_score,
        virality_reason: virality_reason.trim(),
        hooks: hooks.map((hook) => hook.trim()),
      })
      .select("id, titulo, virality_score, virality_reason, hooks, created_at")
      .single();

    if (insertError) {
      console.error("No se pudo guardar el análisis en Supabase:", insertError.message);
      return jsonResponse({ error: "El análisis se completó, pero no se pudo guardar." }, 500);
    }

    return jsonResponse({
      analysis: {
        titulo: saved.titulo,
        virality_score: saved.virality_score,
        virality_reason: saved.virality_reason,
        hooks: saved.hooks,
      },
    });
  } catch (error) {
    console.error("Falló el análisis de la transcripción:", error);
    return jsonResponse({ error: "No se pudo analizar la transcripción. Inténtalo de nuevo." }, 502);
  }
});
