import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const app = express();
app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendDir = path.resolve(__dirname, '../frontend');
app.use(express.static(frontendDir));

let AZURE_OPENAI_KEY = '';
let AZURE_OPENAI_ENDPOINT = '';
let AZURE_DEPLOYMENT_NAME = '';

function loadAzureConfig() {
    AZURE_OPENAI_KEY = process.env.AZURE_OPENAI_KEY || '';
    AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || '';
    AZURE_DEPLOYMENT_NAME = process.env.AZURE_DEPLOYMENT_NAME || '';

    const keyFilePath = path.join(__dirname, 'key.txt');
    if (fs.existsSync(keyFilePath)) {
        const fileContent = fs.readFileSync(keyFilePath, 'utf8');
        const lines = fileContent.split(/\r?\n/);
        lines.forEach(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return;
            const parts = trimmed.split('=');
            if (parts.length >= 2) {
                const key = parts[0].trim();
                const value = parts.slice(1).join('=').trim();
                if (key === 'AZURE_OPENAI_KEY') AZURE_OPENAI_KEY = value;
                else if (key === 'AZURE_OPENAI_ENDPOINT') AZURE_OPENAI_ENDPOINT = value;
                else if (key === 'AZURE_DEPLOYMENT_NAME') AZURE_DEPLOYMENT_NAME = value;
            }
        });
    }
}

loadAzureConfig();
const reportDir = path.join(__dirname, 'report');

// Log API key status on startup
if (AZURE_OPENAI_KEY) {
    console.log(`✓ Azure OpenAI Key loaded successfully (${AZURE_OPENAI_KEY.substring(0, 10)}...)`);
} else {
    console.warn('✗ Azure OpenAI Key NOT found - check key.txt');
}

// Define the strict Akinator State JSON Response Schema for OpenAI Structured Outputs
const businessAnalystSchema = {
    type: "object",
    properties: {
        deduced_operational_facts: {
            type: "array",
            items: { type: "string" },
            description: "List of all concrete business problems, tools, software, or process roadblocks uncovered so far."
        },
        xray_pillar_clarity_scores: {
            type: "object",
            properties: {
                Processes: { type: "integer", description: "Clarity percentage on workflows and manual friction." },
                Systems: { type: "integer", description: "Clarity percentage on software and disconnected tool dependencies." },
                Data_Information: { type: "integer", description: "Clarity percentage on patchy visibility and reporting delay gaps." },
                People: { type: "integer", description: "Clarity percentage on team overstretch or communication silos." },
                Performance: { type: "integer", description: "Clarity percentage on lost hours, financial errors, or metrics." }
            },
            required: ["Processes", "Systems", "Data_Information", "People", "Performance"],
            additionalProperties: false
        },
        current_question_count: {
            type: "integer",
            description: "Increment by 1 at every turn of the interview."
        },
        next_logical_target: {
            type: "string",
            description: "The Business X-Ray pillar with the lowest clarity score that needs immediate probing next."
        },
        is_absurd_or_meaningless_input: {
            type: "boolean",
            description: "Set to true if the user's latest message contains gibberish, jokes, or completely off-topic words."
        },
        natural_analyst_response: {
            type: "string",
            description: "Your human-sounding response. Keep it ultra-short and simple (maximum 1-2 short sentences). Empathetically acknowledge user input in 5-8 words, then ask ONE exceptionally direct, single-focus question."
        }
    },
    required: [
        "deduced_operational_facts",
        "xray_pillar_clarity_scores",
        "current_question_count",
        "next_logical_target",
        "is_absurd_or_meaningless_input",
        "natural_analyst_response"
    ],
    additionalProperties: false
};

const SYSTEM_INSTRUCTION = `
You are an elite AI Business Analyst representing the firm SilkOptima. Your objective is to run a logical "Business X-Ray" interview framework to uncover structural inefficiencies, automation candidates, and data visibility gaps.

CORE OPERATIONAL RULES:
1. AKINATOR STRATEGY: Do not follow a static question script. Actively evaluate user inputs, deduct context, and calculate clarity scores. Target your questions strictly at the weakest score area.
2. BREVITY & SIMPLICITY: Your questions must be incredibly simple, short, and bite-sized. Avoid long or multi-part questions. Speak plainly. Use a maximum of 1-2 sentences total for your entire response.
3. EMPATHETIC & GROWN-UP: Sound human. Validate their structural frustrations briefly instead of robotically jumping to the next template item. Avoid all buzzword-heavy sales consulting jargon.
4. ANTI-REPETITION GUARD: Check your "deduced_operational_facts" list before asking anything. If a user previously mentioned a tool or workflow, cross it off mentally. Never ask basic or overlapping discovery questions twice.
5. ABSURD RESPONSE PROTECTION: If the user provides an absurd response (e.g., gibberish, random text), flag "is_absurd_or_meaningless_input" as true, ignore their response, bypass complex topics, and formulate a drastically simplified question to guide them back safely.
6. SESSION TERMINATION: Maximize data collection. The conversation strictly caps at 10 turns.
`;

app.post('/api/chat', async (req, res) => {
    try {
        if (!AZURE_OPENAI_KEY || !AZURE_OPENAI_ENDPOINT) {
            return res.status(500).json({
                error: "Azure OpenAI key or endpoint missing. Check key.txt."
            });
        }

        const { chatHistory } = req.body;

        if (!chatHistory || !Array.isArray(chatHistory)) {
            return res.status(400).json({ error: "Missing or malformed chatHistory array" });
        }

        // Map frontend message objects to OpenAI chat format
        const messages = [
            { role: "system", content: SYSTEM_INSTRUCTION },
            ...chatHistory.map(msg => ({
                role: msg.role === 'assistant' ? 'assistant' : 'user',
                content: msg.text
            }))
        ];



        const apiUrl = AZURE_OPENAI_ENDPOINT;

        const requestBody = {
            messages: messages,
            temperature: 0.2,
            response_format: {
                type: "json_schema",
                json_schema: {
                    name: "business_analyst",
                    strict: true,
                    schema: businessAnalystSchema
                }
            }
        };

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api-key': AZURE_OPENAI_KEY
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`OpenAI API Error (${response.status}): ${errText}`);
        }

        const data = await response.json();
        
        // Parse and return the structured state machine response directly to frontend
        const analystState = JSON.parse(data.choices[0].message.content);

        if (Number(analystState.current_question_count) >= 10) {
            fs.mkdirSync(reportDir, { recursive: true });
            const reportFile = path.join(reportDir, `chat-report-${Date.now()}.json`);
            const fullChat = [
                ...chatHistory,
                { role: 'assistant', text: analystState.natural_analyst_response }
            ];

            const reportPayload = {
                createdAt: new Date().toISOString(),
                current_question_count: analystState.current_question_count,
                deduced_operational_facts: analystState.deduced_operational_facts,
                xray_pillar_clarity_scores: analystState.xray_pillar_clarity_scores,
                chatHistory: fullChat
            };

            fs.writeFileSync(reportFile, JSON.stringify(reportPayload, null, 2), 'utf8');
        }

        res.json(analystState);

    } catch (error) {
        console.error("API Processing Error:", error);
        const errorText = (error && typeof error.message === 'string') ? error.message : '';

        res.status(500).json({ error: "Internal Analyst Engine Error: " + (errorText || "Unknown error") });
    }
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`Silk Analyst Backend Live on http://localhost:${PORT}`));