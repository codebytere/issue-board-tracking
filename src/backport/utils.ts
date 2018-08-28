import { Application, Context } from 'probot';
import * as GitHub from '@octokit/rest';
import fetch from 'node-fetch';

import * as commands from './commands';
import { Label, PullRequest, TropConfig } from './Probot';
import queue from './Queue';
import { runCommand } from './runner';

const TARGET_LABEL_PREFIX = 'target/';
const MERGED_LABEL_PREFIX = 'merged/';

const labelToTargetBranch = (label: Label, prefix: string) => {
  return label.name.replace(prefix, '');
};

const getGitHub = () => {
  const g = new GitHub();
  g.authenticate({
    type: 'token',
    token: process.env.GITHUB_FORK_USER_TOKEN!,
  });
  return g;
};

const createBackportComment = (pr: PullRequest) => {
  let body = `Backport of #${pr.number}\n\nSee that PR for details.`;

  // tslint:disable-next-line
  const issueFixInfo = new RegExp(`(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved) (${pr.base.repo.html_url}/issues/\\d+)`, 'i');
  const issueMatch = pr.body.match(issueFixInfo);

  // attach information about issues resolved, if any
  if (Array.isArray(issueMatch) && issueMatch.length > 1) {
    body += `\n\n ${issueMatch[0]}`;
  }

  const notesInfo = new RegExp(`(?:(?:\r?\n)|^)notes: (.+?)(?:(?:\r?\n)|$)`, 'gi');
  const notesMatch = pr.body.match(notesInfo);

  // attach release notes to backport PR body
  if (Array.isArray(notesMatch) && notesMatch.length > 1) {
    body += `\n\n ${notesMatch}`;
  } else {
    body += '\n\nNotes: no-notes';
  }

  return body;
};

const backportImpl = async (robot: Application,
                            context: Context,
                            targetBranch: string,
                            labelToRemove?: string,
                            labelToAdd?: string) => {
  const base = context.payload.pull_request.base;
  const slug = `${base.repo.owner.login}/${base.repo.name}`;
  const bp = `backport from PR #${context.payload.pull_request.number} to "${targetBranch}"`;
  robot.log(`Queuing ${bp} for "${slug}"`);

  const log = (...args: string[]) => robot.log(slug, ...args);

  queue.enterQueue(
    async () => {
      log(`Executing ${bp} for "${slug}"`);
      await new Promise<void>(resolve => setTimeout(resolve, 5000));
      const pr = context.payload.pull_request as any as PullRequest;
      // Set up empty repo on master
      log('Setting up local repository');
      await runCommand({
        what: commands.INIT_REPO,
        payload: {
          owner: base.repo.owner.login,
          repo: base.repo.name,
        },
      });
      log('Working directory cleaned');

      // Fork repository to trop
      log('forking base repo');
      const gh = getGitHub();
      const fork = (await gh.repos.fork({
        owner: base.repo.owner.login,
        repo: base.repo.name,
      })).data;

      let forkReady = false;
      let attempt = 0;
      while (!forkReady && attempt < 20) {
        log(`testing fork - Attempt ${attempt + 1}/20`);
        try {
          const { data } = await gh.repos.getCommits({
            owner: fork.owner.login,
            repo: fork.name!,
          });
          forkReady = data.length > 0;
        } catch (err) {
          // Ignore
        }
        attempt += 1;
        if (!forkReady) await new Promise<void>(resolve => setTimeout(resolve, 5000));
      }
      if (attempt >= 20) {
        log('fork wasn\'t ready fast enough, giving up');
        throw new Error('Not ready in time');
      }
      log('fork ready');

      // Set up remotes
      log('setting up remotes');
      await runCommand({
        what: commands.SET_UP_REMOTES,
        payload: {
          slug,
          remotes: [{
            name: 'target_repo',
            value: `https://github.com/${slug}.git`,
          }, {
            name: 'fork',
            // tslint:disable-next-line
            value: `https://${fork.owner.login}:${process.env.GITHUB_FORK_USER_TOKEN}@github.com/${fork.owner.login}/${fork.name}.git`,
          }],
        },
      });

      // Get list of commits
      log(`Getting rev list from: ${pr.base.sha}..${pr.head.sha}`);
      const commits: string[] = (await context.github.pullRequests.getCommits(context.repo({
        number: pr.number,
      }))).data.map(commit => commit.sha!);

      // No commits == WTF
      if (commits.length === 0) {
        log('Found no commits to backport, aborting');
        return;
      }

      if (commits.length >= 240) {
        // Over 240 commits is probably the limit from github so let's not bother
        log(`Way to many commits (${commits.length})... Giving up`);
        await context.github.issues.createComment(context.repo({
          number: pr.number,
          body: 'This PR has wayyyy too many commits to automatically backport, \
  please do this manually',
        }) as any);

        return;
      }

      log(`Found ${commits.length} commits to backport, requesting details now`);
      const patches: string[] = [];
      let i = 1;
      for (const commit of commits) {
        const patchUrl = `https://github.com/${slug}/pull/${pr.number}/commits/${commit}.patch`;
        const patchBody = await fetch(patchUrl);
        patches.push(await patchBody.text());
        log(`Got patch (${i}/${commits.length})`);
        i += 1;
      }
      log('Got all commit info');

      // Temp branch on the fork
      const sanitizedTitle = pr.title.replace(/ /g, '-').replace(/\:/g, '-').toLowerCase();
      const tempBranch = `${targetBranch}-bp-${sanitizedTitle}-${Date.now()}`;

      log(`Checking out target: "target_repo/${targetBranch}" to temp: "${tempBranch}"`);
      log('Will start backporting now');

      await runCommand({
        what: commands.BACKPORT,
        payload: {
          slug,
          targetBranch,
          tempBranch,
          patches,
          targetRemote: 'target_repo',
          tempRemote: 'fork',
        },
      });

      log('Cherry pick success, pushed up to fork');

      log('Creating Pull Request');
      const newPr = (await context.github.pullRequests.create(context.repo({
        head: `${fork.owner.login}:${tempBranch}`,
        base: targetBranch,
        title: `${pr.title} (backport: ${targetBranch})`,
        body: createBackportComment(pr),
        maintainer_can_modify: false,
      }))).data;

      log('Adding breadcrumb comment');
      await context.github.issues.createComment(context.repo({
        number: pr.number,
        body: `We have automatically backported this PR to "${targetBranch}", \
  please check out #${newPr.number}`,
      }) as any);

      if (labelToRemove) {
        log(`Removing label '${labelToRemove}'`);
        await context.github.issues.removeLabel(context.repo({
          number: pr.number,
          name: labelToRemove,
        }));
      }

      if (labelToAdd) {
        log(`Adding label '${labelToAdd}'`);
        await context.github.issues.addLabels(context.repo({
          number: pr.number,
          labels: [labelToAdd],
        }));
      }

      await context.github.issues.addLabels(context.repo({
        number: newPr.number!,
        labels: ['backport'],
      }));

      log('Backport complete');
    },
    async () => {
      const pr = context.payload.pull_request;

      await context.github.issues.createComment(context.repo({
        number: pr.number,
        body: `An error occurred while attempting to backport this PR to "${targetBranch}",
  you will need to perform this backport manually`,
      }) as any);
    },
  );
};

const getLabelPrefixes = async (context: Context) => {
  const config = await context.config<TropConfig>('config.yml') || {};
  const target = config.targetLabelPrefix || TARGET_LABEL_PREFIX;
  const merged = config.mergedLabelPrefix || MERGED_LABEL_PREFIX;
  return { target, merged };
};

export const backportToLabel = async (
  robot: Application,
  context: Context,
  label: Label,
) => {
  const labelPrefixes = await getLabelPrefixes(context);
  if (!label.name.startsWith(labelPrefixes.target)) {
    robot.log(`Label '${label.name}' does not begin with '${labelPrefixes.target}'`);
    return;
  }

  const targetBranch = labelToTargetBranch(label, labelPrefixes.target);
  if (!targetBranch) {
    robot.log('Nothing to do');
    return;
  }

  const labelToRemove = label.name;
  const labelToAdd = label.name.replace(labelPrefixes.target, labelPrefixes.merged);
  await backportImpl(robot, context, targetBranch, labelToRemove, labelToAdd);
};

export const backportToBranch = async (
  robot: Application,
  context: Context,
  targetBranch: string,
) => {
  const labelPrefixes = await getLabelPrefixes(context);

  const labelToRemove = undefined;
  const labelToAdd = labelPrefixes.merged + targetBranch;
  await backportImpl(robot, context, targetBranch, labelToRemove, labelToAdd);
};
