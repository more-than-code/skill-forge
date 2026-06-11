import { get } from 'node:http';

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8001';

function makeRequest(path) {
    return new Promise((resolve, reject) => {
        get(`${BACKEND_URL}${path}`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(e);
                    }
                } else {
                    reject(new Error(`Status ${res.statusCode}: ${data}`));
                }
            });
        }).on('error', reject);
    });
}

async function debug() {
    try {
        console.log('Searching for "BlackRock Finance"...');
        const searchResults = await makeRequest('/api/v1/entities/search?q=BlackRock%20Finance');
        console.log('Search results:', JSON.stringify(searchResults, null, 2));

        if (!searchResults || searchResults.length === 0) {
            console.log('No entity found.');
            return;
        }

        const cik = searchResults[0].cik;
        console.log(`Using CIK: ${cik}`);

        console.log(`Fetching sector allocation for ${cik} / 2025Q1...`);
        try {
            const sectorData = await makeRequest(`/api/v1/entities/${cik}/sector-allocation?quarter=2025Q1`);
            console.log('Sector Data:', JSON.stringify(sectorData, null, 2));
        } catch (e) {
            console.error('Failed to fetch sector data:', e.message);
        }

    } catch (e) {
        console.error('Debug script failed:', e.message);
    }
}

debug();
