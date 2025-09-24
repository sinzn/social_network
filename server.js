require("dotenv").config();
const express = require("express"),
  mysql = require("mysql2/promise"),
  bcrypt = require("bcryptjs"),
  multer = require("multer"),
  path = require("path"),
  fs = require("fs");

const session = require("express-session"),
  RedisStore = require("connect-redis").default,
  Redis = require("ioredis");

const app = express();
app.use(express.urlencoded({ extended: 1 }));

// ---------- File uploads ----------
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
const upload = multer({ dest: uploadDir });
app.use("/uploads", express.static(uploadDir));

// ---------- Redis + Session ----------
const redis = new Redis({ host: process.env.REDIS_HOST, port: 6379 });
app.use(
  session({
    store: new RedisStore({ client: redis }),
    secret: process.env.SESSION_SECRET,
    resave: 0,
    saveUninitialized: 0,
  })
);

// ---------- MySQL ----------
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

// ---------- Auth Page ----------
const authPage = `<!DOCTYPE html><html><head><title>Auth</title><script>
function t(f){login.style.display=f?'none':'block';register.style.display=f?'block':'none';}
</script></head><body><div align=center style=margin-top:100px>
<form id=login method=post action=/login><table cellpadding=8>
<tr><td>Email:</td><td><input name=u type=email required></td></tr>
<tr><td>Password:</td><td><input name=p type=password required></td></tr>
<tr><td></td><td><input type=submit value=Login> <input type=button value=Register onclick=t(1)></td></tr></table></form>
<form id=register method=post action=/register style=display:none><table cellpadding=8>
<tr><td>Username:</td><td><input name=ru required></td></tr>
<tr><td>Email:</td><td><input name=re type=email required></td></tr>
<tr><td>Password:</td><td><input name=rp type=password required></td></tr>
<tr><td></td><td><input type=submit value=Register> <input type=button value=Login onclick=t(0)></td></tr></table></form>
</div></body></html>`;

// ---------- Routes ----------
app.get("/", async (q, r) => {
  if (!q.session.user) return r.send(authPage);

  let [posts] = await db.query(
    "SELECT p.id,p.content,p.image,u.username,(SELECT COUNT(*) FROM likes WHERE post_id=p.id) as likes,p.created_at FROM posts p JOIN users u ON p.user_id=u.id ORDER BY p.created_at DESC"
  );

  let feed = posts
    .map(
      (p) => `<div style='border:1px solid #999;border-radius:10px;padding:10px;margin:15px;width:420px;text-align:left'>
        <b>${p.username}</b> <small style="color:gray">(${new Date(
        p.created_at
      ).toLocaleString()})</small><br>
        <p>${p.content || ""}</p>
        ${p.image ? `<img src='/uploads/${p.image}' width=400 style='border-radius:8px'><br>` : ""}
        ❤️ ${p.likes} 
        <form style='display:inline' method=post action=/like>
          <input type=hidden name=post_id value=${p.id}>
          <button type=submit>Like</button>
        </form>
        ${
          q.session.user.username === p.username
            ? `<form style='display:inline' method=post action=/deletepost>
                 <input type=hidden name=post_id value=${p.id}>
                 <button type=submit>Delete</button>
               </form>`
            : ""
        }
      </div>`
    )
    .join("");

  r.send(`<div align=center style=margin-top:30px>
    <h2>Welcome ${q.session.user.username}</h2>
    <a href=/logout><button>Logout</button></a>
    <h3>Create Post</h3>
    <form method=post action=/post enctype=multipart/form-data>
      <textarea name=content rows=3 cols=40 placeholder="What's on your mind?" required></textarea><br><br>
      <input type=file name=photo accept="image/*"><br><br>
      <input type=submit value="Post">
    </form>
    <h3>Feed</h3>
    ${feed || "<p>No posts yet.</p>"}
  </div>`);
});

app.post("/register", async (q, r) => {
  let { ru, re, rp } = q.body,
    h = await bcrypt.hash(rp, 10);
  try {
    await db.query("INSERT INTO users(username,email,password)VALUES(?,?,?)", [
      ru,
      re,
      h,
    ]);
    r.send("✅ Registered. <a href='/'>Login</a>");
  } catch {
    r.send("⚠️ Email exists.");
  }
});

app.post("/login", async (q, r) => {
  let { u, p } = q.body;
  let cache = await redis.get(u);
  if (cache) {
    let user = JSON.parse(cache);
    if (await bcrypt.compare(p, user.password)) {
      q.session.user = { id: user.id, username: user.username };
      return r.redirect("/");
    }
  }
  let [rows] = await db.query("SELECT * FROM users WHERE email=?", [u]);
  if (rows.length && (await bcrypt.compare(p, rows[0].password))) {
    await redis.set(u, JSON.stringify(rows[0]), "EX", 300);
    q.session.user = { id: rows[0].id, username: rows[0].username };
    return r.redirect("/");
  }
  r.send("❌ Invalid. <a href='/'>Retry</a>");
});

app.post("/post", upload.single("photo"), async (q, r) => {
  if (!q.session.user) return r.redirect("/");
  let { content } = q.body;
  let image = q.file ? q.file.filename : null;
  await db.query("INSERT INTO posts(user_id,content,image) VALUES(?,?,?)", [
    q.session.user.id,
    content,
    image,
  ]);
  r.redirect("/");
});

app.post("/deletepost", async (q, r) => {
  if (!q.session.user) return r.redirect("/");
  let { post_id } = q.body;

  let [rows] = await db.query("SELECT * FROM posts WHERE id=?", [post_id]);
  if (rows.length && rows[0].user_id === q.session.user.id) {
    if (rows[0].image) {
      let imgPath = path.join(uploadDir, rows[0].image);
      if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
    }
    await db.query("DELETE FROM posts WHERE id=?", [post_id]);
  }
  r.redirect("/");
});

app.post("/like", async (q, r) => {
  if (!q.session.user) return r.redirect("/");
  let { post_id } = q.body;
  await db.query(
    "INSERT IGNORE INTO likes(user_id,post_id) VALUES(?,?)",
    [q.session.user.id, post_id]
  );
  r.redirect("/");
});

app.get("/logout", (q, r) => q.session.destroy(() => r.redirect("/")));

app.listen(3000, () => console.log("http://localhost:3000"));

