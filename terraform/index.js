// AWS SDK v3
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
  UpdateCommand,
  GetCommand,
  DeleteCommand
} = require("@aws-sdk/lib-dynamodb");

const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const {
  TranscribeClient,
  StartTranscriptionJobCommand,
  GetTranscriptionJobCommand
} = require("@aws-sdk/client-transcribe");
const crypto = require("crypto");

// === CONFIG ===
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const transcribe = new TranscribeClient({ region: process.env.REGION });

const TASKS_TABLE = process.env.TASKS_TABLE_NAME;
const AUDIO_BUCKET = process.env.AUDIO_BUCKET;

// === HELPERS ===
function getUserId(event) {
  return event.requestContext?.authorizer?.jwt?.claims?.sub;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization,content-type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS"
  };
}

function json(status, body) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders()
    },
    body: JSON.stringify(body)
  };
}

function nextMidnight() {
  const now = new Date();
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1
  ).toISOString();
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

const ALLOWED_STATUSES = ["TODO", "SNOOZE", "DONE", "ARCHIVED", "INACTIVE"];

async function autoUnsnooze(userId, tasks) {
  const now = new Date().toISOString();

  const updates = [];

  for (const t of tasks) {
    if (t.status === "SNOOZE" && t.snoozedUntil && t.snoozedUntil <= now) {
      updates.push(
        dynamo.send(
          new UpdateCommand({
            TableName: TASKS_TABLE,
            Key: { userId, taskId: t.taskId },
            UpdateExpression:
              "SET #s = :todo, snoozedUntil = :null, updatedAt = :u",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
              ":todo": "TODO",
              ":null": null,
              ":u": new Date().toISOString()
            }
          })
        )
      );
      t.status = "TODO";
      t.snoozedUntil = null;
    }
  }

  if (updates.length > 0) await Promise.all(updates);
  return tasks;
}

async function autoSnoozeOverdue(userId, tasks) {
  const todayStart = startOfToday();
  const updates = [];

  for (const t of tasks) {
    if (t.status === "TODO") {
      if (t.dueDate) {
        const due = new Date(t.dueDate);
        const dueDayStart = new Date(
          due.getFullYear(),
          due.getMonth(),
          due.getDate()
        ).toISOString();

        // Geplante Aufgaben (auch am Fälligkeitstag) nicht automatisch snoozen
        if (dueDayStart >= todayStart) continue;
      }

      const lastTouch = t.updatedAt || t.createdAt;
      if (lastTouch && lastTouch < todayStart) {
        const now = new Date().toISOString();
        const until = nextMidnight();

        updates.push(
          dynamo.send(
            new UpdateCommand({
              TableName: TASKS_TABLE,
              Key: { userId, taskId: t.taskId },
              UpdateExpression:
                "SET #s = :s, snoozeCount = if_not_exists(snoozeCount, :zero) + :one, snoozedUntil = :until, updatedAt = :u",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":s": "SNOOZE",
                ":one": 1,
                ":zero": 0,
                ":until": until,
                ":u": now
              }
            })
          )
        );

        t.status = "SNOOZE";
        t.snoozeCount = (t.snoozeCount || 0) + 1;
        t.snoozedUntil = until;
        t.updatedAt = now;
      }
    }
  }

  if (updates.length > 0) await Promise.all(updates);
  return tasks;
}

async function autoArchiveDone(userId, tasks) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const updates = [];

  for (const t of tasks) {
    if (t.status === "DONE") {
      const doneAt = t.doneAt || t.updatedAt || t.createdAt;
      if (doneAt && doneAt < sevenDaysAgo) {
        const now = new Date().toISOString();

        updates.push(
          dynamo.send(
            new UpdateCommand({
              TableName: TASKS_TABLE,
              Key: { userId, taskId: t.taskId },
              UpdateExpression:
                "SET #s = :arch, archivedAt = :a, updatedAt = :u",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":arch": "ARCHIVED",
                ":a": now,
                ":u": now
              }
            })
          )
        );

        t.status = "ARCHIVED";
        t.archivedAt = now;
        t.updatedAt = now;
      }
    }
  }

  if (updates.length > 0) await Promise.all(updates);
  return tasks;
}

function sanitizeJobName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 200);
}

async function waitForTranscription(jobName, timeoutMs = 20000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const { TranscriptionJob } = await transcribe.send(
      new GetTranscriptionJobCommand({ TranscriptionJobName: jobName })
    );

    const status = TranscriptionJob?.TranscriptionJobStatus;
    if (status === "COMPLETED") {
      const transcriptUrl = TranscriptionJob.Transcript?.TranscriptFileUri;
      if (!transcriptUrl) throw new Error("Transcript URL missing");

      const res = await fetch(transcriptUrl);
      const data = await res.json();
      const text = data?.results?.transcripts?.[0]?.transcript;
      if (!text) throw new Error("Transcript empty");
      return text;
    }

    if (status === "FAILED") {
      throw new Error(TranscriptionJob?.FailureReason || "Transcription failed");
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error("Transcription timeout");
}

// === MAIN HANDLER ===
exports.handler = async (event) => {
  const method =
    event?.requestContext?.http?.method ||
    event?.requestContext?.httpMethod;

  const path = event?.requestContext?.http?.path || event.rawPath;

  // === OPTIONS ===
  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders()
    };
  }

  // === AUTH ===
  const userId = getUserId(event);
  if (!userId) return json(401, { error: "Unauthorized" });

  try {
    // =======================
    // GET /tasks
    // =======================
    if (method === "GET" && path === "/tasks") {
      const res = await dynamo.send(
        new QueryCommand({
          TableName: TASKS_TABLE,
          KeyConditionExpression: "userId = :u",
          ExpressionAttributeValues: { ":u": userId }
        })
      );

      let tasks = res.Items || [];
      tasks = await autoUnsnooze(userId, tasks);
      tasks = await autoSnoozeOverdue(userId, tasks);
      tasks = await autoArchiveDone(userId, tasks);
      return json(200, tasks);
    }

    // =======================
    // POST /tasks
    // =======================
    if (method === "POST" && path === "/tasks") {
      const body = JSON.parse(event.body || "{}");
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      let dueDate = null;
      if (body.dueDate) {
        const parsed = new Date(body.dueDate);
        if (isNaN(parsed.getTime())) {
          return json(400, { error: "Invalid dueDate" });
        }
        dueDate = new Date(
          parsed.getFullYear(),
          parsed.getMonth(),
          parsed.getDate()
        ).toISOString();
      }

      // Respect the explicit status coming from the client. Without trimming we
      // might accidentally interpret a provided "inactive" flag as empty and
      // fall back to TODO.
      let status = body.status === undefined
        ? "TODO"
        : String(body.status).trim().toUpperCase();
      if (!ALLOWED_STATUSES.includes(status)) {
        return json(400, { error: "Invalid status" });
      }

      const item = {
        userId,
        taskId: id,
        title: body.title,
        description: body.description,
        status,
        createdAt: now,
        updatedAt: now,
        snoozeCount: 0,
        snoozedUntil: null,
        audioKey: null,
        dueDate,
        doneAt: null,
        archivedAt: null
      };

      await dynamo.send(
        new PutCommand({
          TableName: TASKS_TABLE,
          Item: item
        })
      );

      return json(200, item);
    }

    // =======================
    // PUT /tasks/{id}
    // =======================
    if (method === "PUT" && path.startsWith("/tasks/") && !path.endsWith("/audio")) {
      const taskId = path.split("/")[2];
      const body = JSON.parse(event.body || "{}");

      const now = new Date().toISOString();

      // robust optional fields
      const exp = [];
      const names = { "#s": "status" };
      const vals = { ":arch": "ARCHIVED" };

      if (body.status !== undefined) {
        const nextStatus = String(body.status).toUpperCase();
        if (!ALLOWED_STATUSES.includes(nextStatus)) {
          return json(400, { error: "Invalid status" });
        }
        exp.push("#s = :s");
        vals[":s"] = nextStatus;
      }

      if (body.title !== undefined) {
        exp.push("#t = :t");
        names["#t"] = "title";
        vals[":t"] = body.title;
      }
      if (body.description !== undefined) {
        exp.push("#d = :d");
        names["#d"] = "description";
        vals[":d"] = body.description;
      }

      if (body.dueDate !== undefined) {
        if (body.dueDate === null) {
          exp.push("dueDate = :null");
          vals[":null"] = null;
        } else {
          const parsed = new Date(body.dueDate);
          if (isNaN(parsed.getTime())) {
            return json(400, { error: "Invalid dueDate" });
          }
          const normalizedDue = new Date(
            parsed.getFullYear(),
            parsed.getMonth(),
            parsed.getDate()
          ).toISOString();
          exp.push("dueDate = :due");
          vals[":due"] = normalizedDue;
        }
      }

      exp.push("updatedAt = :u");
      vals[":u"] = now;

      const res = await dynamo.send(
        new UpdateCommand({
          TableName: TASKS_TABLE,
          Key: { userId, taskId },
          UpdateExpression: "SET " + exp.join(", "),
          ExpressionAttributeValues: vals,
          ExpressionAttributeNames: names,
          ConditionExpression: "#s <> :arch",
          ReturnValues: "ALL_NEW"
        })
      );

      return json(200, res.Attributes);
    }

    // =======================
    // POST /tasks/{id}/snooze
    // =======================
    if (method === "POST" && path.endsWith("/snooze")) {
      const taskId = path.split("/")[2];
      const now = new Date().toISOString();

      const res = await dynamo.send(
        new UpdateCommand({
          TableName: TASKS_TABLE,
          Key: { userId, taskId },
          UpdateExpression:
            "SET #s = :s, snoozeCount = if_not_exists(snoozeCount, :zero) + :one, snoozedUntil = :until, updatedAt = :u",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":s": "SNOOZE",
            ":one": 1,
            ":zero": 0,
            ":until": nextMidnight(),
            ":u": now,
            ":arch": "ARCHIVED",
            ":done": "DONE"
          },
          ConditionExpression: "#s <> :arch AND #s <> :done",
          ReturnValues: "ALL_NEW"
        })
      );

      return json(200, res.Attributes);
    }

    // =======================
    // POST /tasks/{id}/done
    // =======================
    if (method === "POST" && path.endsWith("/done")) {
      const taskId = path.split("/")[2];
      const now = new Date().toISOString();

      const res = await dynamo.send(
        new UpdateCommand({
          TableName: TASKS_TABLE,
          Key: { userId, taskId },
          UpdateExpression:
            "SET #s = :s, snoozedUntil = :null, doneAt = :now, updatedAt = :u",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":s": "DONE",
            ":null": null,
            ":u": now,
            ":now": now,
            ":arch": "ARCHIVED"
          },
          ConditionExpression: "#s <> :arch",
          ReturnValues: "ALL_NEW"
        })
      );

      return json(200, res.Attributes);
    }

    // =======================
    // POST /tasks/{id}/reactivate
    // =======================
    if (method === "POST" && path.endsWith("/reactivate")) {
      const taskId = path.split("/")[2];
      const now = new Date();

      const existing = await dynamo.send(
        new GetCommand({
          TableName: TASKS_TABLE,
          Key: { userId, taskId }
        })
      );

      if (!existing.Item) return json(404, { error: "Task not found" });

      const snoozedUntilDate = existing.Item.snoozedUntil
        ? new Date(existing.Item.snoozedUntil)
        : null;
      const shouldDecreaseSnoozeCount =
        existing.Item.status === "SNOOZE" &&
        snoozedUntilDate &&
        snoozedUntilDate > now;

      const updateParts = [
        "#s = :todo",
        "snoozedUntil = :null",
        "doneAt = :null",
        "archivedAt = :null",
        "updatedAt = :u"
      ];

      const values = {
        ":todo": "TODO",
        ":null": null,
        ":u": now.toISOString(),
        ":arch": "ARCHIVED"
      };

      if (shouldDecreaseSnoozeCount) {
        const newCount = Math.max(0, (existing.Item.snoozeCount || 0) - 1);
        updateParts.push("snoozeCount = :sc");
        values[":sc"] = newCount;
      }

      const res = await dynamo.send(
        new UpdateCommand({
          TableName: TASKS_TABLE,
          Key: { userId, taskId },
          UpdateExpression: "SET " + updateParts.join(", "),
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: values,
          ConditionExpression: "#s <> :arch",
          ReturnValues: "ALL_NEW"
        })
      );

      return json(200, res.Attributes);
    }

    // =======================
    // DELETE /tasks/{id}
    // =======================
    if (method === "DELETE" && path.startsWith("/tasks/") && !path.endsWith("/audio")) {
      const taskId = path.split("/")[2];

      const res = await dynamo.send(
        new GetCommand({
          TableName: TASKS_TABLE,
          Key: { userId, taskId }
        })
      );

      if (!res.Item) return json(404, { error: "Task not found" });
      if (res.Item.status !== "DONE") {
        return json(400, { error: "Task must be DONE before deleting" });
      }

      if (res.Item.audioKey) {
        await s3.send(
          new DeleteObjectCommand({
            Bucket: AUDIO_BUCKET,
            Key: res.Item.audioKey
          })
        );
      }

      await dynamo.send(
        new DeleteCommand({
          TableName: TASKS_TABLE,
          Key: { userId, taskId }
        })
      );

      return json(200, { ok: true });
    }

    // =======================
    // GET /tasks/{id}/audio
    // =======================
    if (method === "GET" && path.endsWith("/audio")) {
      const taskId = path.split("/")[2];

      const res = await dynamo.send(
        new GetCommand({
          TableName: TASKS_TABLE,
          Key: { userId, taskId }
        })
      );

      if (!res.Item) return json(404, { error: "Task not found" });
      if (!res.Item.audioKey) return json(404, { error: "No audio for task" });

      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: AUDIO_BUCKET, Key: res.Item.audioKey }),
        { expiresIn: 300 }
      );

      return json(200, { url });
    }

    // =======================
    // PUT /tasks/{id}/audio
    // =======================
    if (method === "PUT" && path.endsWith("/audio")) {
      const taskId = path.split("/")[2];
      const body = JSON.parse(event.body || "{}");

      if (!body.base64) {
        return json(400, { error: "Missing base64 audio data" });
      }

      const audioData = Buffer.from(body.base64, "base64");
      const key = `audio/${userId}/${taskId}.webm`;

      await s3.send(
        new PutObjectCommand({
          Bucket: AUDIO_BUCKET,
          Key: key,
          Body: audioData,
          ContentType: "audio/webm"
        })
      );

      const now = new Date().toISOString();

      const res = await dynamo.send(
        new UpdateCommand({
          TableName: TASKS_TABLE,
          Key: { userId, taskId },
          UpdateExpression: "SET audioKey = :k, updatedAt = :u",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":k": key,
            ":u": now,
            ":arch": "ARCHIVED"
          },
          ConditionExpression: "#s <> :arch",
          ReturnValues: "ALL_NEW"
        })
      );

      return json(200, res.Attributes);
    }

    // =======================
    // POST /tasks/{id}/transcribe
    // =======================
    if (method === "POST" && path.endsWith("/transcribe")) {
      const taskId = path.split("/")[2];

      const res = await dynamo.send(
        new GetCommand({
          TableName: TASKS_TABLE,
          Key: { userId, taskId }
        })
      );

      if (!res.Item) return json(404, { error: "Task not found" });
      if (res.Item.status === "ARCHIVED") return json(400, { error: "Task is archived" });
      if (!res.Item.audioKey) return json(400, { error: "No audio for task" });

      const mediaUrl = `s3://${AUDIO_BUCKET}/${res.Item.audioKey}`;

      const jobName = sanitizeJobName(`tadone-${userId}-${taskId}-${Date.now()}`);

      await transcribe.send(
        new StartTranscriptionJobCommand({
          TranscriptionJobName: jobName,
          LanguageCode: "de-DE",
          MediaFormat: "webm",
          Media: { MediaFileUri: mediaUrl }
        })
      );

      const transcript = await waitForTranscription(jobName);

      await dynamo.send(
        new UpdateCommand({
          TableName: TASKS_TABLE,
          Key: { userId, taskId },
          UpdateExpression: "SET updatedAt = :u",
          ExpressionAttributeValues: { ":u": new Date().toISOString() },
          ReturnValues: "ALL_NEW"
        })
      );

      return json(200, { transcript });
    }

    // Unknown
    return json(404, { error: "Route not found", method, path });
  } catch (err) {
    console.error("ERROR:", err);
    if (err?.name === "ConditionalCheckFailedException") {
      return json(400, { error: "Operation not allowed on this task" });
    }
    return json(500, { error: err.message || "Server error" });
  }
};
