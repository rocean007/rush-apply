/**
 * Web Worker: Resume text parsing
 * Runs off the main thread to avoid UI jank when processing large resume texts
 */

self.onmessage = (e: MessageEvent<{ text: string }>) => {
  const { text } = e.data;

  try {
    const parsed = parseResume(text);
    self.postMessage({ success: true, data: parsed });
  } catch (err: any) {
    self.postMessage({ success: false, error: err.message });
  }
};

interface ParsedResume {
  skills: string[];
  emails: string[];
  phones: string[];
  sections: Record<string, string>;
}

/** Extract structured data from plain-text resume */
function parseResume(text: string): ParsedResume {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Extract emails
  const emails = [...text.matchAll(/[\w.-]+@[\w.-]+\.\w+/g)].map(m => m[0]);

  // Extract phone numbers
  const phones = [...text.matchAll(/(\+?\d[\d\s\-().]{7,}\d)/g)].map(m => m[0].trim());

  // Extract skills (lines with comma-separated short words)
  const skills: string[] = [];
  for (const line of lines) {
    if (line.split(',').length > 2 && line.length < 200) {
      skills.push(...line.split(',').map(s => s.trim()).filter(s => s.length < 30));
    }
  }

  // Extract sections by heading patterns
  const sections: Record<string, string> = {};
  let currentSection = 'header';
  let buffer: string[] = [];

  for (const line of lines) {
    if (/^(EXPERIENCE|EDUCATION|SKILLS|SUMMARY|PROJECTS|CERTIFICATIONS)/i.test(line)) {
      if (buffer.length) sections[currentSection] = buffer.join('\n');
      currentSection = line.toLowerCase();
      buffer = [];
    } else {
      buffer.push(line);
    }
  }
  if (buffer.length) sections[currentSection] = buffer.join('\n');

  return { skills: [...new Set(skills)].slice(0, 30), emails, phones, sections };
}
