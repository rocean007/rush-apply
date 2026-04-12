export interface User {
  id: string;
  email: string;
  fullName: string;
  title?: string;
  skills: string[];
  experience: Experience[];
  education: Education[];
  resumeText?: string;
}

export interface Experience {
  company: string;
  role: string;
  start: string;
  end?: string;
  bullets: string[];
}

export interface Education {
  school: string;
  degree: string;
  year: string;
}

export interface Job {
  id: string;
  title: string;
  company: string;
  location: string;
  description?: string;
  url: string;
  source: string;
  salaryMin?: number;
  salaryMax?: number;
  tags: string[];
  isRemote: boolean;
  scrapedAt: string;
}

export interface Application {
  id: string;
  jobId: string;
  title: string;
  company: string;
  url: string;
  location: string;
  status: 'pending' | 'applied' | 'interviewing' | 'rejected' | 'offer';
  coverLetter?: string;
  appliedAt: string;
}

export interface JobsResponse {
  jobs: Job[];
  total: number;
  page: number;
  pages: number;
}
