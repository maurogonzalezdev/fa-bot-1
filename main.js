require("dotenv").config();

const puppeteer = require("puppeteer");
const express = require("express");
const glitchup = require("glitchup");
const fs = require("fs");

const app = express();
const port = process.env.PORT || 3000;

const cookiesPath = "cookies.json";
let browser;
let page;

async function initializeBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({ args: ["--no-sandbox"] });
    page = await browser.newPage();
    await loadCookies(page);
  }
}

async function login(page, forumUrl, username, password) {
  // Verificar si el usuario ya está logueado
  await page.goto(`${forumUrl}/`);
  const loggedIn = (await page.$('div.copyright-body a[href^="/admin/?"]')) !== null;

  if (!loggedIn) {
    console.log("User is not logged in. Logging in...");
    await page.goto(`${forumUrl}/login`);
    await page.waitForSelector('input[name="login"]');
    await page.type('input[name="username"]', username);
    await page.type('input[name="password"]', password);
    await page.click('input[name="login"]');
    await page.waitForNavigation();

    // Guardar las cookies después de iniciar sesión
    const cookies = await page.cookies();
    fs.writeFileSync(cookiesPath, JSON.stringify(cookies));
  } else {
    console.log("User is already logged in.");
  }
}

async function loadCookies(page) {
  if (fs.existsSync(cookiesPath)) {
    const cookies = JSON.parse(fs.readFileSync(cookiesPath));
    await page.setCookie(...cookies);
  }
}

async function readPostContent(page, href) {
  try {
    console.log(`Navigating to post: ${href}`);
    await page.goto(href);
    const content = await page.evaluate(() => {
      const postBody = document.querySelector('.postbody');
      return postBody ? postBody.innerText : 'No content found'; // Ajusta el selector según la estructura de tu foro
    });
    console.log(`Content of post ${href}: ${content}`);
  } catch (error) {
    console.error(`Error while reading post ${href}:`, error);
  }
}

async function checkForNewPosts(page, forumUrl, username, password) {
  try {
    await login(page, forumUrl, username, password);
    await page.goto(`${forumUrl}/f1-your-first-forum`);
    
    // Obtener todos los hrefs en un solo contexto de evaluación
    const hrefs = await page.evaluate(() => {
      const topics = document.querySelectorAll('.topictitle');
      return Array.from(topics).map(topic => topic.href);
    });

    if (hrefs.length > 0) {
      for (const href of hrefs) {
        await readPostContent(page, href);
      }
    } else {
      console.log("No new posts found.");
    }
  } catch (error) {
    console.error("Error while checking for new posts:", error);
  }
}

app.post("/check-posts", async (req, res) => {
  await initializeBrowser();
  await checkForNewPosts(
    page,
    process.env.FORUM_URL,
    process.env.MOD_USERNAME,
    process.env.MOD_PASSWORD
  );
  res.send("Checked for new posts");
});

// Configurar glitchup para mantener la aplicación activa
glitchup("/ping");

// Configurar el servidor Express para el endpoint de ping
app.get("/ping", (req, res) => {
  res.send("pong");
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

// Verificar la sesión cada 55 minutos para evitar la desconexión automática
setInterval(async () => {
  await initializeBrowser();
  await login(page, process.env.FORUM_URL, process.env.MOD_USERNAME, process.env.MOD_PASSWORD);
}, 55 * 60 * 1000); // 55 minutos en milisegundos