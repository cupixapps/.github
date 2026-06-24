import { promises as fs } from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, idx, arr) => {
    if (!cur.startsWith('--')) return acc;
    const key = cur.slice(2);
    const next = arr[idx + 1];
    acc.push([key, next && !next.startsWith('--') ? next : 'true']);
    return acc;
  }, [])
);

const repoRoot = process.cwd();
const readmePath = path.resolve(repoRoot, args.readme ?? 'profile/README.md');
const changeLogPath = args['change-log'] ? path.resolve(repoRoot, args['change-log']) : null;

const org = args.org ?? 'cupixapps';
const token = process.env.GITHUB_TOKEN;
const title = 'Cupix Apps';
const description = 'Cupix 프론트엔드 팀의 GitHub organization입니다.';
const defaultDescription = '설명 없음';
const defaultSectionTitle = 'Repositories';
const sections = [
  {
    title: defaultSectionTitle,
    topics: []
  },
  {
    title: 'Automation',
    topics: ['automation']
  },
  {
    title: 'Internal',
    topics: ['internal']
  },
  {
    title: 'Shared Config',
    topics: ['shared-config']
  }
];

if (!org) {
  throw new Error('Missing organization. Use --org.');
}

const fetchRepos = async () => {
  const allRepos = [];
  let page = 1;

  while (true) {
    const url = `https://api.github.com/orgs/${org}/repos?type=all&per_page=100&page=${page}&sort=full_name`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        ...(token ? { Authorization: 'Bearer ' + token } : {})
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub API request failed (${response.status}): ${body}`);
    }

    const pageRepos = await response.json();
    if (!Array.isArray(pageRepos) || pageRepos.length === 0) break;

    allRepos.push(...pageRepos);
    if (pageRepos.length < 100) break;
    page += 1;
  }

  return allRepos;
};

const githubGetJson = async (url) => {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API request failed (${response.status}): ${body}`);
  }

  return response.json();
};

const fetchRepoTopics = async (repoName) => {
  const body = await githubGetJson(`https://api.github.com/repos/${org}/${repoName}/topics`);
  return Array.isArray(body.names) ? body.names : [];
};

const parseExistingRepoNames = (content) => {
  if (!content) return new Set();
  const regex = /<b>([^<]+)<\/b>/g;
  const names = new Set();
  let match;

  while ((match = regex.exec(content)) !== null) {
    names.add(match[1]);
  }

  return names;
};

const parseExistingRepoDescriptions = (content) => {
  const descriptions = new Map();
  if (!content) return descriptions;

  const regex = /^\| <a href="[^"]+" target="_blank"><b>([^<]+)<\/b><\/a> \| (.*) \|$/gm;
  let match;

  while ((match = regex.exec(content)) !== null) {
    descriptions.set(match[1], match[2]);
  }

  return descriptions;
};

const parseExistingSectionOrders = (content) => {
  const orders = new Map();
  if (!content) return orders;

  let sectionTitle = null;

  for (const line of content.split('\n')) {
    const sectionMatch = line.match(/^## (.+)$/);
    if (sectionMatch) {
      sectionTitle = sectionMatch[1];
      if (!orders.has(sectionTitle)) {
        orders.set(sectionTitle, []);
      }
      continue;
    }

    if (!sectionTitle) continue;

    const repoMatch = line.match(/<b>([^<]+)<\/b>/);
    if (repoMatch) {
      orders.get(sectionTitle).push(repoMatch[1]);
    }
  }

  return orders;
};

const sectionForRepo = (repo) => {
  const repoTopics = repo.topics ?? [];
  return (
    sections.find(
      (section) =>
        section.title !== defaultSectionTitle &&
        section.topics.some((topic) => repoTopics.includes(topic))
    ) ?? sections[0]
  );
};

const htmlLink = (repo) =>
  `<a href="${repo.html_url}" target="_blank"><b>${repo.name}</b></a>`;

const sanitizeDescription = (description, fallback) => {
  const base = description?.trim() || fallback;
  return base.replace(/\|/g, '\\|');
};

const buildSectionRows = (
  repos,
  section,
  fallbackDescription,
  existingDescriptions,
  existingSectionOrders
) => {
  const ordered = [];
  const used = new Set();

  const preferredNames = existingSectionOrders.get(section.title) ?? [];
  for (const name of preferredNames) {
    const repo = repos.find((item) => item.name === name);
    if (repo) {
      ordered.push(repo);
      used.add(repo.name);
    }
  }

  const remaining = repos
    .filter((repo) => !used.has(repo.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  ordered.push(...remaining);

  return ordered.map(
    (repo) =>
      `| ${htmlLink(repo)} | ${sanitizeDescription(
        existingDescriptions.get(repo.name) ?? repo.description,
        fallbackDescription
      )} |`
  );
};

const repos = (await fetchRepos())
  .filter((repo) => !repo.archived)
  .map((repo) => ({
    name: repo.name,
    html_url: repo.html_url,
    description: repo.description
  }));

const reposWithTopics = await Promise.all(
  repos.map(async (repo) => ({
    ...repo,
    topics: await fetchRepoTopics(repo.name)
  }))
);

let previousReadme = '';
try {
  previousReadme = await fs.readFile(readmePath, 'utf8');
} catch {
  previousReadme = '';
}

const existingDescriptions = parseExistingRepoDescriptions(previousReadme);
const existingSectionOrders = parseExistingSectionOrders(previousReadme);
const previousNames = parseExistingRepoNames(previousReadme);
const visibleNames = new Set(reposWithTopics.map((repo) => repo.name));
const missingPreviousNames = [...previousNames]
  .filter((name) => !visibleNames.has(name))
  .sort();

if (missingPreviousNames.length > 0) {
  throw new Error(
    [
      'GitHub API did not return repositories that are already listed in the README.',
      'The token may not have access to private organization repositories, or the repositories were removed.',
      'Missing repositories:',
      ...missingPreviousNames.map((name) => `- ${name}`)
    ].join('\n')
  );
}

const sectionMap = new Map(sections.map((section) => [section.title, []]));

for (const repo of reposWithTopics) {
  const section = sectionForRepo(repo);
  sectionMap.get(section.title).push(repo);
}

const lines = [];
lines.push('<!-- This file is auto-generated by scripts/generate-profile-readme.mjs -->');
lines.push(`# ${title}`);
lines.push('');
lines.push(description);

for (const section of sections) {
  const reposInSection = sectionMap.get(section.title) ?? [];
  if (reposInSection.length === 0) continue;

  lines.push('');
  lines.push(`## ${section.title}`);
  lines.push('');
  lines.push('| Repo | Description |');
  lines.push('|------|-------------|');
  lines.push(
    ...buildSectionRows(
      reposInSection,
      section,
      defaultDescription,
      existingDescriptions,
      existingSectionOrders
    )
  );
}

lines.push('');
const nextReadme = `${lines.join('\n')}\n`;

await fs.writeFile(readmePath, nextReadme, 'utf8');

if (changeLogPath) {
  const nextNames = new Set(reposWithTopics.map((repo) => repo.name));

  const added = [...nextNames].filter((name) => !previousNames.has(name)).sort();
  const removed = [...previousNames].filter((name) => !nextNames.has(name)).sort();

  const report = [
    '## Summary',
    'Automated sync of `profile/README.md` using visible, non-archived repositories in `cupixapps`.',
    '',
    '## Repository changes',
    '',
    '### Added',
    ...(added.length > 0 ? added.map((name) => `- \`${name}\``) : ['- None']),
    '',
    '### Removed',
    ...(removed.length > 0 ? removed.map((name) => `- \`${name}\``) : ['- None']),
    '',
    '### Notes',
    '- Private repositories are included when the token can access them.',
    '- Archived repositories are excluded.',
    '- Repositories with `automation`, `internal`, or `shared-config` topics are grouped into matching sections.',
    '- Repositories without a recognized section topic are grouped under `Repositories`.',
    '- Existing README descriptions and section ordering are preserved.',
    '- Empty descriptions are replaced with the default fallback text.'
  ];

  await fs.writeFile(changeLogPath, `${report.join('\n')}\n`, 'utf8');
}

console.log(`Generated ${path.relative(repoRoot, readmePath)} from ${repos.length} repositories.`);
