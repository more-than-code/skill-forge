import { chromium } from 'playwright';

async function inspectPage(url = 'http://localhost:5173') {
  console.log(`Launching browser to inspect: ${url}`);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    console.log('Navigating...');
    const response = await page.goto(url, { waitUntil: 'networkidle' });
    
    if (!response) {
      console.error('Failed to get response');
      return;
    }

    console.log(`Status: ${response.status()}`);
    console.log('--- Page Title ---');
    console.log(await page.title());
    
    console.log('\n--- Page Content (Text) ---');
    // Extract text content from the body
    const text = await page.evaluate(() => document.body.innerText);
    console.log(text);
    
  } catch (error) {
    console.error(`Error processing page: ${error.message}`);
  } finally {
    await browser.close();
  }
}

// Get URL from command line args or default
const targetUrl = process.argv[2] || 'http://localhost:5173';
inspectPage(targetUrl);
