/** AI service using Pollinations (free) with exponential backoff retry */

const POLLINATIONS_URL = process.env.POLLINATIONS_API_URL || 'https://text.pollinations.ai/';

/**
 * Call Pollinations API with exponential backoff retry
 * @param messages - Chat messages array
 * @param maxRetries - Max retry attempts (default 3)
 */
async function callAI(messages: Array<{ role: string; content: string }>, maxRetries = 3): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(POLLINATIONS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, model: 'openai', seed: 42 }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) throw new Error(`Pollinations error: ${response.status}`);
      return await response.text();
    } catch (e: any) {
      lastError = e;
      if (attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  // Fallback: try Groq if API key available
  if (process.env.GROQ_API_KEY) {
    return callGroq(messages);
  }

  throw lastError || new Error('AI call failed');
}

/** Groq fallback (free tier, fast Llama inference) */
async function callGroq(messages: Array<{ role: string; content: string }>): Promise<string> {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.2-3b-preview',
      messages,
      max_tokens: 1500,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json() as any;
  return data.choices?.[0]?.message?.content || '';
}

/**
 * Generate AI-tailored resume for a job description
 */
export async function generateResume(user: any, jobDescription: string): Promise<string> {
  const userContext = `
Name: ${user.full_name}
Title: ${user.title || 'Professional'}
Skills: ${JSON.parse(user.skills || '[]').join(', ')}
Experience: ${JSON.stringify(JSON.parse(user.experience || '[]'))}
Education: ${JSON.stringify(JSON.parse(user.education || '[]'))}
  `.trim();

  return callAI([
    {
      role: 'system',
      content: 'You are an expert resume writer. Create concise, ATS-optimized resumes in plain text format. Focus on quantifiable achievements and keywords from the job description.',
    },
    {
      role: 'user',
      content: `Tailor a professional resume for this candidate:\n\n${userContext}\n\nJob Description:\n${jobDescription}\n\nProvide a clean, formatted resume ready for submission.`,
    },
  ]);
}

/**
 * Generate AI cover letter for a specific job
 */
export async function generateCoverLetter(user: any, job: any): Promise<string> {
  return callAI([
    {
      role: 'system',
      content: 'Write concise, compelling cover letters (under 250 words). Be specific, professional, and avoid clichés.',
    },
    {
      role: 'user',
      content: `Write a cover letter for ${user.full_name} applying to ${job.title} at ${job.company}.\n\nJob description: ${job.description?.slice(0, 500)}\n\nCandidate skills: ${user.skills}`,
    },
  ]);
}

/**
 * Generate form-filling suggestions for a job application
 */
export async function generateFormAnswers(user: any, questions: string[]): Promise<Record<string, string>> {
  const result = await callAI([
    {
      role: 'system',
      content: 'You are filling out job application forms. Return ONLY a JSON object mapping question to answer. Keep answers concise and professional.',
    },
    {
      role: 'user',
      content: `Candidate: ${user.full_name}, ${user.title}\nSkills: ${user.skills}\n\nQuestions:\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\nReturn JSON only.`,
    },
  ]);

  try {
    return JSON.parse(result.replace(/```json\n?|\n?```/g, '').trim());
  } catch {
    return {};
  }
}
