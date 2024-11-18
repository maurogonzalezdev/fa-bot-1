// main.js

require("dotenv").config();

const { Cluster } = require('puppeteer-cluster');
const express = require("express");
const glitchup = require("glitchup");
const fs = require("fs");

const app = express();
const port = process.env.PORT || 3000;

const cookiesPath = "cookies.json";
const CONCURRENT_OPERATIONS = 5;
const NAVIGATION_TIMEOUT = 30000; // 30 segundos

async function initializeCluster() {
  const cluster = await Cluster.launch({
    concurrency: Cluster.CONCURRENCY_CONTEXT,
    maxConcurrency: CONCURRENT_OPERATIONS,
    puppeteerOptions: {
      args: ["--no-sandbox"],
      headless: true,
      defaultViewport: null,
      timeout: NAVIGATION_TIMEOUT,
    },
  });

  // Manejar errores en las tareas del clúster
  await cluster.on('taskerror', (err, data) => {
    console.error(`Error crawling ${data}: ${err.message}`);
  });

  // Realizar login una vez y compartir el contexto
  await cluster.execute(async ({ page }) => {
    await loadCookies(page);
    await login(page, process.env.FORUM_URL, process.env.MOD_USERNAME, process.env.MOD_PASSWORD);
  });

  // Definir la tarea del clúster con bloqueo de recursos no esenciales
  await cluster.task(async ({ page, data: href }) => {
    // Bloquear recursos no esenciales
    await page.setRequestInterception(true);
    page.on('request', request => {
      const resourceType = request.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    const content = await readPostContent(page, href);
    return { href, content };
  });

  return cluster;
}

async function loadCookies(page) {
  if (fs.existsSync(cookiesPath)) {
    const cookies = JSON.parse(fs.readFileSync(cookiesPath));
    await page.setCookie(...cookies);
  }
}

async function login(page, forumUrl, username, password) {
  await page.goto(`${forumUrl}/`, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });
  const loggedIn = await page.$('div.copyright-body a[href^="/admin/?"]');

  if (!loggedIn) {
    console.log("User is not logged in. Logging in...");
    await page.goto(`${forumUrl}/login`, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });
    await page.waitForSelector('input[name="login"]', { timeout: NAVIGATION_TIMEOUT });
    await page.type('input[name="username"]', username, { delay: 50 });
    await page.type('input[name="password"]', password, { delay: 50 });
    await Promise.all([
      page.click('input[name="login"]'),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT }),
    ]);

    const cookies = await page.cookies();
    fs.writeFileSync(cookiesPath, JSON.stringify(cookies));
  } else {
    console.log("User is already logged in.");
  }
}

async function readPostContent(page, href) {
  try {
    console.log(`Navigating to post: ${href}`);
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });
    const content = await page.evaluate(() => {
      const postBody = document.querySelector('.postbody');
      return postBody ? postBody.innerText.trim() : 'No content found';
    });
    console.log(`Content of post ${href}: ${content}`);
    return content;
  } catch (error) {
    console.error(`Error while reading post ${href}:`, error);
    return null;
  }
}

async function checkForNewPosts(cluster, forumUrl) {
  try {
    const hrefs = await cluster.execute(async ({ page }) => {
      await page.goto(`${forumUrl}/f1-your-first-forum`, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });
      const links = await page.evaluate(() => {
        const topics = document.querySelectorAll('.topictitle');
        return Array.from(topics).map(topic => topic.href);
      });
      return links;
    });

    const results = await Promise.all(
      hrefs.map(href => cluster.execute(href))
    );

    await cluster.idle();
    return results;
  } catch (error) {
    console.error("Error while checking for new posts:", error);
    return [];
  }
}

app.post("/check-posts", async (req, res) => {
  try {
    const cluster = await initializeCluster();
    const results = await checkForNewPosts(cluster, process.env.FORUM_URL);
    await cluster.close();
    res.json({ success: true, posts: results });
  } catch (error) {
    console.error("Error in /check-posts:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/ping", (req, res) => {
  res.send("pong");
});

glitchup("/ping");

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

// Verificar la sesión periódicamente
setInterval(async () => {
  try {
    const cluster = await initializeCluster();
    await cluster.idle();
    await cluster.close();
  } catch (error) {
    console.error("Error during session refresh:", error);
  }
}, 55 * 60 * 1000); // Cada 55 minutos

process.on('SIGINT', async () => {
  process.exit();
});