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

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const crypto = require("crypto");

// === CONFIG ===
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

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

async function autoUnsnooze(userId, tasks) {
  const now = new Date().toISOString();

  const updates = [];

  for (const t of tasks) {
    if (t.status === "SNOOZE" && t.snoozedUntil < now) {
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

      const cleaned = await autoUnsnooze(userId, res.Items || []);
      return json(200, cleaned);
    }

    // =======================
    // POST /tasks
    // =======================
    if (method === "POST" && path === "/tasks") {
      const body = JSON.parse(event.body || "{}");
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      const item = {
        userId,
        taskId: id,
        title: body.title,
        description: body.description,
        status: "TODO",
        createdAt: now,
        updatedAt: now,
        snoozeCount: 0,
        snoozedUntil: null,
        audioKey: null
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
      const names = {};
      const vals = {};

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

      exp.push("updatedAt = :u");
      vals[":u"] = now;

      const res = await dynamo.send(
        new UpdateCommand({
          TableName: TASKS_TABLE,
          Key: { userId, taskId },
          UpdateExpression: "SET " + exp.join(", "),
          ExpressionAttributeValues: vals,
          ExpressionAttributeNames: names,
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
            "SET #s = :s, snoozeCount = snoozeCount + :one, snoozedUntil = :until, updatedAt = :u",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":s": "SNOOZE",
            ":one": 1,
            ":until": nextMidnight(),
            ":u": now
          },
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
            "SET #s = :s, snoozedUntil = :null, updatedAt = :u",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":s": "DONE",
            ":null": null,
            ":u": now
          },
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
          ExpressionAttributeValues: {
            ":k": key,
            ":u": now
          },
          ReturnValues: "ALL_NEW"
        })
      );

      return json(200, res.Attributes);
    }

    // Unknown
    return json(404, { error: "Route not found", method, path });
  } catch (err) {
    console.error("ERROR:", err);
    return json(500, { error: err.message || "Server error" });
  }
};
