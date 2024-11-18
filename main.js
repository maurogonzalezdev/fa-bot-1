require("dotenv").config();

const { Cluster } = require('puppeteer-cluster');
const express = require("express");
const fs = require("fs");
const chromium = require('chrome-aws-lambda');
const puppeteer = require('puppeteer-core');

const app = express();
app.use(compression());
const port = process.env.PORT || 3000;

const cookiesPath = "/tmp/cookies.json"; // Usar /tmp para almacenamiento temporal en Vercel
const CONCURRENT_OPERATIONS = 5;
const NAVIGATION_TIMEOUT = 30000; // 30 segundos

let clusterInstance = null;

// Inicializar el clúster
async function initializeCluster() {
  if (clusterInstance) return clusterInstance;

  clusterInstance = await Cluster.launch({
    concurrency: Cluster.CONCURRENCY_CONTEXT,
    maxConcurrency: CONCURRENT_OPERATIONS,
    puppeteerOptions: {
      args: [...chromium.args, "--no-sandbox"],
      executablePath: await chromium.executablePath,
      headless: chromium.headless,
      defaultViewport: null,
      timeout: NAVIGATION_TIMEOUT,
    },
  });

  // Verificar la ruta del ejecutable de Chromium
  console.log(`Ruta ejecutable de Chromium: ${await chromium.executablePath}`);

  // Manejar errores en las tareas del clúster
  clusterInstance.on('taskerror', (err, data) => {
    console.error(`Error crawling ${data}: ${err.message}`);
  });

  // Realizar login una vez y compartir el contexto
  await clusterInstance.execute(async ({ page }) => {
    await loadCookies(page);
    await login(page, process.env.FORUM_URL, process.env.MOD_USERNAME, process.env.MOD_PASSWORD);
  });

  // Definir la tarea del clúster con bloqueo de recursos no esenciales
  clusterInstance.task(async ({ page, data: href }) => {
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

  return clusterInstance;
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
    console.log("Usuario no está logueado. Iniciando sesión...");
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
    console.log("Usuario ya está logueado.");
  }
}

async function readPostContent(page, href) {
  try {
    console.log(`Navegando a post: ${href}`);
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });
    const content = await page.evaluate(() => {
      const postBody = document.querySelector('.postbody');
      return postBody ? postBody.innerText.trim() : 'No se encontró contenido';
    });
    console.log(`Contenido del post ${href}: ${content}`);
    return content;
  } catch (error) {
    console.error(`Error al leer el post ${href}:`, error);
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
    console.error("Error al verificar nuevos posts:", error);
    return [];
  }
}

// Endpoint para verificar posts
app.post("/check-posts", async (req, res) => {
  try {
    const cluster = await initializeCluster();
    const results = await checkForNewPosts(cluster, process.env.FORUM_URL);
    res.json({ success: true, posts: results });
  } catch (error) {
    console.error("Error en /check-posts:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint de ping (puede ser útil para otras funcionalidades)
app.get("/ping", (req, res) => {
  res.send("pong");
});

// Iniciar el servidor
app.listen(port, () => {
  console.log(`Servidor corriendo en http://localhost:${port}`);
});

// Verificar la sesión periódicamente
setInterval(async () => {
  try {
    const cluster = await initializeCluster();
    await cluster.idle();
    // Opcional: puedes realizar alguna acción adicional aquí si es necesario
  } catch (error) {
    console.error("Error durante la actualización de sesión:", error);
  }
}, 55 * 60 * 1000); // Cada 55 minutos

// Manejar señal de interrupción para cerrar el clúster correctamente
process.on('SIGINT', async () => {
  console.log("Cerrando clúster...");
  if (clusterInstance) {
    await clusterInstance.close();
  }
  process.exit();
});