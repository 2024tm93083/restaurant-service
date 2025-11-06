import express from "express";
import pkg from "pg";
import dotenv from "dotenv";
const app = express();
app.use(express.json());
dotenv.config();
const { Pool } = pkg;

// === PostgreSQL connection pool ===
const pool = new Pool({
  user: process.env.POSTGRES_USER || "postgres",
  password: process.env.POSTGRES_PASSWORD || "2491",
  host: process.env.POSTGRES_HOST || "localhost",
  port: process.env.POSTGRES_PORT || 5432,
  database: process.env.RESTAURANT_DB || "restaurant_db",
  max: 10,
});

async function waitForDb(retries = 10, delayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      const client = await pool.connect();
      client.release();
      console.log("Database reachable");
      return;
    } catch (err) {
      console.log(
        `DB connect attempt ${
          i + 1
        }/${retries} failed — retrying in ${delayMs}ms`
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("Unable to connect to DB after multiple attempts");
}

// --- Utility ---
async function runQuery(sql, params = []) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res.rows;
  } finally {
    client.release();
  }
}

// Health
app.get("/healthz", (req, res) => res.json({ status: "ok" }));

// List restaurants with optional filters: city, cuisine, min_rating, limit, offset
app.get("/v1/restaurants", async (req, res) => {
  try {
    const { city, cuisine, min_rating, limit = 50, offset = 0 } = req.query;
    let where = [];
    let params = [];

    if (city) {
      params.push(city);
      where.push(`city = $${params.length}`);
    }
    if (cuisine) {
      params.push(cuisine);
      where.push(`cuisine ILIKE $${params.length}`);
    }
    if (min_rating) {
      params.push(min_rating);
      where.push(`rating >= $${params.length}`);
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    params.push(limit, offset);
    const rows = await runQuery(
      `SELECT restaurant_id, name, cuisine, city, rating, is_open, created_at
           FROM restaurant_schema.restaurants
           ${whereClause}
           ORDER BY rating DESC NULLS LAST
           LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch restaurants" });
  }
});

// Get restaurant by id
app.get("/v1/restaurants/:id", async (req, res) => {
  try {
    const rows = await runQuery(
      "SELECT restaurant_id, name, cuisine, city, rating, is_open, created_at FROM restaurant_schema.restaurants WHERE restaurant_id = $1",
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch restaurant" });
  }
});

// Get menu for a restaurant, optional available=true filter and category, pagination
app.get("/v1/restaurants/:id/menu", async (req, res) => {
  try {
    const { available, category, limit = 100, offset = 0 } = req.query;
    let where = ["restaurant_id = $1"];
    let params = [req.params.id];

    if (available === "true") {
      params.push(true);
      where.push(`is_available = $${params.length}`);
    }
    if (category) {
      params.push(category);
      where.push(`category ILIKE $${params.length}`);
    }
    params.push(limit, offset);
    const rows = await runQuery(
      `SELECT item_id, restaurant_id, name, category, price, is_available, created_at
           FROM restaurant_schema.menu_items
           WHERE ${where.join(" AND ")}
           ORDER BY name
           LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch menu" });
  }
});

// Check availability & pricing for a list of item_ids (body: { item_ids: [1,2,3] })
app.post("/v1/menu/validate", async (req, res) => {
  try {
    const { item_ids } = req.body;
    if (!Array.isArray(item_ids) || item_ids.length === 0) {
      return res.status(400).json({ error: "item_ids array required" });
    }
    const vals = item_ids.map((_, i) => `$${i + 1}`).join(",");
    const rows = await runQuery(
      `SELECT item_id, restaurant_id, name, price, is_available FROM restaurant_schema.menu_items WHERE item_id IN (${vals})`,
      item_ids
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Validation failed" });
  }
});

// Basic admin endpoint to toggle is_open (for demos) - PUT /v1/restaurants/:id/open
app.put("/v1/restaurants/:id/open", async (req, res) => {
  try {
    const { is_open } = req.body;
    if (typeof is_open !== "boolean")
      return res.status(400).json({ error: "is_open boolean required" });
    const rows = await runQuery(
      "UPDATE restaurant_schema.restaurants SET is_open = $1 WHERE restaurant_id = $2 RETURNING restaurant_id, is_open",
      [is_open, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update restaurant" });
  }
});

(async () => {
  try {
    await waitForDb(15, 2000);

    const PORT = process.env.PORT || 4000;
    app.listen(PORT, () =>
      console.log(`Restaurant service running on port ${PORT}`)
    );
  } catch (err) {
    console.error("Failed to start restaurant service:", err);
    process.exit(1);
  }
})();
