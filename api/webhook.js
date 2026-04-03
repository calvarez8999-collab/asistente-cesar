import Anthropic from "@anthropic-ai/sdk";
import { Client as NotionClient } from "@notionhq/client";
import { Redis } from "@upstash/redis";

// ─── Clientes ───────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const notion = new NotionClient({ auth: process.env.NOTION_API_KEY });
const redis = Redis.fromEnv();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const NOTION_DB_ID = process.env.NOTION_DATABASE_ID;

// ─── System Prompt ───────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Eres el asistente personal de César Álvarez. Operas por Telegram.

REGLAS DE COMUNICACIÓN:
- Siempre en español, sin excepción
- Respuestas cortas y directas
- Nunca preguntes más de una cosa a la vez
- Tono cercano y claro

CAMPOS OBLIGATORIOS PARA NOTION:
- Tarea: descripción de lo que hay que hacer
- Tipo: exactamente "Solica" o "Personal"
- Estado: exactamente "En espera", "En progreso" o "Completado" (default: En espera)
- Prioridad: exactamente "Alta", "Media" o "Baja"
- Responsable: exactamente "Cesar Alvarez" o "Rosa Ventura" (default: Cesar Alvarez)

CAMPOS OPCIONALES (NO preguntar si no los menciona):
- Fecha de inicio
- Fecha límite
- Notas

FLUJO PARA NUEVA TAREA:
1. Extrae todos los datos que mencionó César en su mensaje
2. Aplica defaults automáticos: Estado = "En espera", Responsable = "Cesar Alvarez"
3. Si Tipo NO está claro → pregunta: "¿Es de Solica o Personal?"
4. Si Prioridad NO está clara → pregunta: "¿Qué prioridad le das? Alta, Media o Baja"
5. Cuando los 5 campos obligatorios estén completos → muestra resumen y pide confirmación:

📋 NUEVA TAREA PARA NOTION

✅ Tarea: [descripción]
✅ Tipo: [Solica/Personal]
✅ Estado: En espera
✅ Prioridad: [Alta/Media/Baja]
✅ Responsable: Cesar Alvarez
⬜ Fecha límite: [si mencionó / vacío]

¿Confirmas?

6. Si César confirma → usa la herramienta guardar_en_notion
7. Confirma: "✅ Tarea guardada en Notion"

PALABRAS QUE SUBEN PRIORIDAD AUTOMÁTICAMENTE:
- "urgente", "hoy", "ya", "importante", "crítico" → Prioridad: Alta

PALABRAS QUE BAJAN PRIORIDAD:
- "cuando pueda", "sin prisa", "algún día" → Prioridad: Baja

COMANDOS RÁPIDOS:
- "buenos días" → saluda y pregunta si quiere ver pendientes
- "qué tengo hoy" / "mis pendientes" → usa herramienta obtener_tareas
- "resumen" → usa herramienta obtener_tareas
- "completé [tarea]" → confirma y sugiere actualizarlo en Notion

IMPORTANTE: Eres flexible. Si César dice la tarea con todos los datos en un mensaje
(ej: "Llamar al doctor, Solica, Alta"), extrae todo y no hagas preguntas innecesarias.`;

// ─── Herramientas (Tools) para Claude ────────────────────────────────────────
const tools = [
  {
    name: "guardar_en_notion",
    description:
      "Guarda una tarea en la base de datos Notion de César. Solo usar cuando todos los campos obligatorios estén confirmados.",
    input_schema: {
      type: "object",
      properties: {
        tarea: {
          type: "string",
          description: "Descripción de la tarea",
        },
        tipo: {
          type: "string",
          enum: ["Solica", "Personal"],
          description: "Tipo de tarea",
        },
        estado: {
          type: "string",
          enum: ["En espera", "En progreso", "Completado"],
          description: "Estado actual",
        },
        prioridad: {
          type: "string",
          enum: ["Alta", "Media", "Baja"],
          description: "Nivel de prioridad",
        },
        responsable: {
          type: "string",
          description: "Nombre del responsable",
        },
        fecha_limite: {
          type: "string",
          description: "Fecha límite en formato YYYY-MM-DD (opcional)",
        },
        notas: {
          type: "string",
          description: "Notas adicionales (opcional)",
        },
      },
      required: ["tarea", "tipo", "estado", "prioridad", "responsable"],
    },
  },
  {
    name: "obtener_tareas",
    description: "Obtiene las tareas pendientes de Notion para mostrar un resumen",
    input_schema: {
      type: "object",
      properties: {
        filtro: {
          type: "string",
          enum: ["todas", "alta_prioridad", "hoy"],
          description: "Qué tareas mostrar",
        },
      },
      required: ["filtro"],
    },
  },
];

// ─── Función: Guardar en Notion ───────────────────────────────────────────────
async function guardarEnNotion(datos) {
  const properties = {
    Tarea: { title: [{ text: { content: datos.tarea } }] },
    Tipo: { select: { name: datos.tipo } },
    Estado: { status: { name: datos.estado } },
    Prioridad: { select: { name: datos.prioridad } },
    Responsable: { select: { name: datos.responsable } },
  };

  if (datos.fecha_limite) {
    properties["Fecha límite"] = { date: { start: datos.fecha_limite } };
  }

  if (datos.notas) {
    properties["Notas"] = {
      rich_text: [{ text: { content: datos.notas } }],
    };
  }

  await notion.pages.create({
    parent: { database_id: NOTION_DB_ID },
    properties,
  });
}

// ─── Función: Obtener tareas de Notion ───────────────────────────────────────
async function obtenerTareas(filtro) {
  const filtros = {
    filter: {
      property: "Estado",
      select: { does_not_equal: "Completado" },
    },
    sorts: [{ property: "Prioridad", direction: "descending" }],
    page_size: 10,
  };

  const response = await notion.databases.query({
    database_id: NOTION_DB_ID,
    ...filtros,
  });

  const tareas = response.results.map((page) => {
    const props = page.properties;
    const tarea = props.Tarea?.title?.[0]?.text?.content || "Sin título";
    const prioridad = props.Prioridad?.select?.name || "—";
    const estado = props.Estado?.select?.name || "—";
    const fechaLimite = props["Fecha límite"]?.date?.start || null;

    return { tarea, prioridad, estado, fechaLimite };
  });

  let respuesta = "📋 TUS PENDIENTES\n\n";
  const altas = tareas.filter((t) => t.prioridad === "Alta");
  const medias = tareas.filter((t) => t.prioridad === "Media");
  const bajas = tareas.filter((t) => t.prioridad === "Baja");

  if (altas.length) {
    respuesta += "🔴 URGENTE\n";
    altas.forEach(
      (t) =>
        (respuesta += `  • ${t.tarea}${t.fechaLimite ? " — vence " + t.fechaLimite : ""}\n`)
    );
    respuesta += "\n";
  }

  if (medias.length) {
    respuesta += "🟡 MEDIA PRIORIDAD\n";
    medias.forEach((t) => (respuesta += `  • ${t.tarea}\n`));
    respuesta += "\n";
  }

  if (bajas.length) {
    respuesta += "🟢 SIN PRISA\n";
    bajas.forEach((t) => (respuesta += `  • ${t.tarea}\n`));
  }

  return respuesta || "No tienes pendientes activos. ✅";
}

// ─── Función: Enviar mensaje a Telegram ──────────────────────────────────────
async function enviarMensaje(chatId, texto) {
  await fetch(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: texto,
        parse_mode: "HTML",
      }),
    }
  );
}

// ─── Función: Descargar y transcribir audio de Telegram ──────────────────────
async function transcribirAudio(fileId) {
  // Obtener URL del archivo
  const fileRes = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`
  );
  const fileData = await fileRes.json();
  const filePath = fileData.result.file_path;

  // Descargar el audio
  const audioRes = await fetch(
    `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`
  );
  const audioBuffer = await audioRes.arrayBuffer();

  // Transcribir con Whisper via Anthropic (usando archivo)
  // Por ahora retornamos aviso — se activa cuando César confirme setup
  return "[Audio recibido — transcripción activa próximamente. Por favor escribe tu mensaje.]";
}

// ─── Handler principal ───────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true });
  }

  const { message } = req.body;
  if (!message) return res.status(200).json({ ok: true });

  const chatId = message.chat.id;
  const texto = message.text || "";
  const voz = message.voice || null;

  // Obtener historial de conversación
  let historial = (await redis.get(`chat:${chatId}`)) || [];

  // Manejar mensaje de voz
  let mensajeUsuario = texto;
  if (voz && !texto) {
    mensajeUsuario = await transcribirAudio(voz.file_id);
  }

  if (!mensajeUsuario) {
    return res.status(200).json({ ok: true });
  }

  // Agregar mensaje del usuario al historial
  historial.push({ role: "user", content: mensajeUsuario });

  // Mantener solo los últimos 20 mensajes
  if (historial.length > 20) {
    historial = historial.slice(-20);
  }

  try {
    // Llamar a Claude
    const respuesta = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      messages: historial,
    });

    let textoRespuesta = "";
    const contenidoAsistente = respuesta.content;

    // Procesar respuesta de Claude
    for (const bloque of contenidoAsistente) {
      if (bloque.type === "text") {
        textoRespuesta += bloque.text;
      } else if (bloque.type === "tool_use") {
        // Ejecutar herramienta
        let resultadoHerramienta = "";

        if (bloque.name === "guardar_en_notion") {
          await guardarEnNotion(bloque.input);
          resultadoHerramienta = "Tarea guardada exitosamente en Notion.";
        } else if (bloque.name === "obtener_tareas") {
          resultadoHerramienta = await obtenerTareas(bloque.input.filtro);
        }

        // Agregar resultado al historial y pedir respuesta final
        historial.push({ role: "assistant", content: contenidoAsistente });
        historial.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: bloque.id,
              content: resultadoHerramienta,
            },
          ],
        });

        const respuestaFinal = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 512,
          system: SYSTEM_PROMPT,
          tools,
          messages: historial,
        });

        textoRespuesta =
          respuestaFinal.content.find((b) => b.type === "text")?.text ||
          resultadoHerramienta;

        historial.push({
          role: "assistant",
          content: respuestaFinal.content,
        });
      }
    }

    // Guardar historial actualizado
    if (!textoRespuesta.includes("tool_use")) {
      historial.push({ role: "assistant", content: contenidoAsistente });
    }

    await redis.set(`chat:${chatId}`, historial.slice(-20), { ex: 86400 });

    // Enviar respuesta a Telegram
    if (textoRespuesta) {
      await enviarMensaje(chatId, textoRespuesta);
    }
  } catch (error) {
    console.error("Error:", error);
    await enviarMensaje(
      chatId,
      "Hubo un error procesando tu mensaje. Intenta de nuevo."
    );
  }

  return res.status(200).json({ ok: true });
}
