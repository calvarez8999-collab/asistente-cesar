import Anthropic from "@anthropic-ai/sdk";
import { Client as NotionClient } from "@notionhq/client";
import { Redis } from "@upstash/redis";
import { google } from "googleapis";

// ─── Clientes ───────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const notion = new NotionClient({ auth: process.env.NOTION_API_KEY });
const redis = Redis.fromEnv();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const NOTION_DB_ID = process.env.NOTION_DATABASE_ID;

// ─── Google Calendar OAuth2 ──────────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "https://developers.google.com/oauthplayground"
);
oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});
const calendarClient = google.calendar({ version: "v3", auth: oauth2Client });

// ─── System Prompt ───────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Eres el asistente personal de César Álvarez. Operas por Telegram.

REGLAS DE COMUNICACIÓN:
- Siempre en español, sin excepción
- Respuestas cortas y directas
- Nunca preguntes más de una cosa a la vez
- Tono cercano y claro

━━━ TIPO 1: RECORDATORIOS → Google Calendar ━━━

Son eventos con fecha Y hora específica. NO van a Notion.

Ejemplos: "Recuérdame llamar al doctor mañana a las 3pm", "Junta con equipo el viernes a las 10", "Cita dentista el 15 de abril a las 11am"

FLUJO:
1. Identifica: qué, fecha, hora
2. Si falta fecha u hora → pregunta solo eso
3. Cuando tengas los 3 datos, muestra confirmación:

📅 NUEVO RECORDATORIO EN CALENDAR

✅ Título: [qué]
✅ Fecha: [día y fecha]
✅ Hora: [hora]
⏰ Recordatorio automático: 30 min antes

¿Confirmas?

4. Si confirma → usa herramienta crear_evento_calendar
5. Confirma: "✅ Agendado en Google Calendar: [título] — [fecha] a las [hora]"

━━━ TIPO 2: TAREAS → Notion ━━━

Son tareas estructuradas que necesitan seguimiento. NO tienen hora exacta.

Ejemplos: "Llama al proveedor de X", "Revisar contrato con Rosa", "Preparar presentación para cliente"

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

━━━ CÓMO DISTINGUIR TIPO 1 vs TIPO 2 ━━━

→ Tiene hora específica ("a las 3pm", "a las 10am") → CALENDAR
→ No tiene hora, es una tarea a completar → NOTION
→ Duda o ambiguo → pregunta: "¿Quieres que lo agende en tu calendario con hora, o lo registro como tarea en Notion?"

━━━ PALABRAS QUE SUBEN PRIORIDAD (solo para Notion) ━━━
- "urgente", "hoy", "ya", "importante", "crítico" → Prioridad: Alta

PALABRAS QUE BAJAN PRIORIDAD:
- "cuando pueda", "sin prisa", "algún día" → Prioridad: Baja

━━━ COMANDOS RÁPIDOS ━━━
- "buenos días" → saluda y pregunta si quiere ver pendientes
- "qué tengo hoy" / "mis pendientes" → usa herramienta obtener_tareas
- "resumen" → usa herramienta obtener_tareas
- "completé [tarea]" → confirma y sugiere actualizarlo en Notion
- "qué tengo en el calendario" → usa herramienta obtener_eventos_calendar

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
  {
    name: "crear_evento_calendar",
    description:
      "Crea un evento o recordatorio en Google Calendar de César. Usar para cosas con fecha y hora específica (citas, juntas, llamadas agendadas).",
    input_schema: {
      type: "object",
      properties: {
        titulo: {
          type: "string",
          description: "Título del evento",
        },
        fecha_hora_inicio: {
          type: "string",
          description: "Fecha y hora de inicio en formato ISO 8601, ej: 2025-04-05T15:00:00",
        },
        fecha_hora_fin: {
          type: "string",
          description:
            "Fecha y hora de fin en formato ISO 8601. Si no se especifica, se asume 1 hora después del inicio.",
        },
        descripcion: {
          type: "string",
          description: "Descripción o notas del evento (opcional)",
        },
        es_todo_el_dia: {
          type: "boolean",
          description: "true si es evento de todo el día sin hora específica",
        },
      },
      required: ["titulo", "fecha_hora_inicio"],
    },
  },
  {
    name: "obtener_eventos_calendar",
    description:
      "Obtiene los próximos eventos del Google Calendar de César para mostrar su agenda.",
    input_schema: {
      type: "object",
      properties: {
        dias: {
          type: "number",
          description: "Cuántos días hacia adelante consultar (por defecto 7)",
        },
      },
      required: [],
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
      status: { does_not_equal: "Completado" },
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
    const estado = props.Estado?.status?.name || props.Estado?.select?.name || "—";
    const fechaLimite = props["Fecha límite"]?.date?.start || null;

    return { tarea, prioridad, estado, fechaLimite };
  });

  let respuesta = "📋 TUS PENDIENTES\n\n";
  const altas = tareas.filter((t) => t.prioridad === "Alta");
  const medias = tareas.filter((t) => t.prioridad === "Media");
  const bajas = tareas.filter((t) => t.prioridad === "Baja");

  if (!tareas.length) return "No tienes pendientes activos. ✅";

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

  return respuesta;
}

// ─── Función: Crear evento en Google Calendar ────────────────────────────────
async function crearEventoCalendar(datos) {
  let event;

  if (datos.es_todo_el_dia) {
    const fechaSolo = datos.fecha_hora_inicio.split("T")[0];
    event = {
      summary: datos.titulo,
      start: { date: fechaSolo },
      end: { date: fechaSolo },
    };
  } else {
    const inicio = datos.fecha_hora_inicio;
    const finMs = new Date(inicio).getTime() + 60 * 60 * 1000;
    const fin = datos.fecha_hora_fin || new Date(finMs).toISOString().slice(0, 19);

    event = {
      summary: datos.titulo,
      start: {
        dateTime: inicio,
        timeZone: "America/Mexico_City",
      },
      end: {
        dateTime: fin,
        timeZone: "America/Mexico_City",
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: "popup", minutes: 30 },
        ],
      },
    };
  }

  if (datos.descripcion) event.description = datos.descripcion;

  const result = await calendarClient.events.insert({
    calendarId: "primary",
    resource: event,
  });

  return `Evento creado: ${result.data.summary} — ${result.data.start.dateTime || result.data.start.date}`;
}

// ─── Función: Obtener eventos de Google Calendar ─────────────────────────────
async function obtenerEventosCalendar(dias = 7) {
  const ahora = new Date();
  const hasta = new Date();
  hasta.setDate(hasta.getDate() + dias);

  const response = await calendarClient.events.list({
    calendarId: "primary",
    timeMin: ahora.toISOString(),
    timeMax: hasta.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 15,
  });

  const eventos = response.data.items || [];

  if (!eventos.length) return `No tienes eventos en los próximos ${dias} días. 📅`;

  let respuesta = `📅 TU AGENDA (próximos ${dias} días)\n\n`;

  for (const ev of eventos) {
    const inicio = ev.start.dateTime
      ? new Date(ev.start.dateTime).toLocaleString("es-MX", {
          timeZone: "America/Mexico_City",
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : ev.start.date;

    respuesta += `  • ${ev.summary || "Sin título"} — ${inicio}\n`;
  }

  return respuesta;
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
  const fileRes = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`
  );
  const fileData = await fileRes.json();
  const filePath = fileData.result.file_path;

  const audioRes = await fetch(
    `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`
  );
  const audioBuffer = await audioRes.arrayBuffer();

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

  let historial = (await redis.get(`chat:${chatId}`)) || [];

  const ahora = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Mexico_City" }));
  const toISO = (d) => d.toISOString().split("T")[0];
  const manana = new Date(ahora); manana.setDate(ahora.getDate() + 1);
  const pasado = new Date(ahora); pasado.setDate(ahora.getDate() + 2);
  const systemPromptConFecha = SYSTEM_PROMPT + `\n\nFECHAS DE REFERENCIA (usar exactamente estas):
- Hoy: ${toISO(ahora)}
- Mañana: ${toISO(manana)}
- Pasado mañana: ${toISO(pasado)}
Cuando el usuario diga "hoy", "mañana", "esta semana", usa estas fechas ISO exactas.`;

  let mensajeUsuario = texto;
  if (voz && !texto) {
    mensajeUsuario = await transcribirAudio(voz.file_id);
  }

  if (!mensajeUsuario) {
    return res.status(200).json({ ok: true });
  }

  historial.push({ role: "user", content: mensajeUsuario });

  if (historial.length > 20) {
    historial = historial.slice(-20);
  }

  try {
    const respuesta = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: systemPromptConFecha,
      tools,
      messages: historial,
    });

    let textoRespuesta = "";
    const contenidoAsistente = respuesta.content;

    for (const bloque of contenidoAsistente) {
      if (bloque.type === "text") {
        textoRespuesta += bloque.text;
      } else if (bloque.type === "tool_use") {
        let resultadoHerramienta = "";

        if (bloque.name === "guardar_en_notion") {
          await guardarEnNotion(bloque.input);
          resultadoHerramienta = "Tarea guardada exitosamente en Notion.";
        } else if (bloque.name === "obtener_tareas") {
          resultadoHerramienta = await obtenerTareas(bloque.input.filtro);
        } else if (bloque.name === "crear_evento_calendar") {
          resultadoHerramienta = await crearEventoCalendar(bloque.input);
        } else if (bloque.name === "obtener_eventos_calendar") {
          resultadoHerramienta = await obtenerEventosCalendar(bloque.input.dias || 7);
        }

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
          system: systemPromptConFecha,
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

    if (!textoRespuesta.includes("tool_use")) {
      historial.push({ role: "assistant", content: contenidoAsistente });
    }

    await redis.set(`chat:${chatId}`, historial.slice(-20), { ex: 86400 });

    if (textoRespuesta) {
      await enviarMensaje(chatId, textoRespuesta);
    }
  } catch (error) {
    console.error("Error:", error);
    if (error?.status === 400 && error?.message?.includes("tool_use")) {
      await redis.del(`chat:${chatId}`);
      await enviarMensaje(chatId, "Reiniciando conversación. Por favor repite tu mensaje.");
    } else {
      await enviarMensaje(chatId, "Hubo un error procesando tu mensaje. Intenta de nuevo.");
    }
  }

  return res.status(200).json({ ok: true });
}
