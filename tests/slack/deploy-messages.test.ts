import { describe, it, expect } from 'vitest';
import {
  buildPreviewReadyMessage,
  buildProductionDeployedMessage,
  buildDeployFailedMessage,
} from '../../src/slack/messages.js';
import type {
  PreviewReadyMessageData,
  ProductionDeployedMessageData,
  DeployFailedMessageData,
} from '../../src/types.js';

describe('buildPreviewReadyMessage', () => {
  const previewData: PreviewReadyMessageData = {
    repoName: 'PassCraft',
    previewUrl: 'https://preview.passcraft.com',
    branch: 'feature/dashboard-filters',
    deployedBy: 'NabilW1995',
    deployedBySlackId: 'U_NABIL',
    issueNumbers: [52, 53],
    commitMessage: 'feat: add date filter to dashboard',
  };

  it('should include Preview Ready text', () => {
    const blocks = buildPreviewReadyMessage(previewData);
    if (blocks[0].type === 'section') {
      expect(blocks[0].text.text).toContain('Preview Ready');
    }
  });

  it('should show preview URL and branch', () => {
    const blocks = buildPreviewReadyMessage(previewData);
    const allText = blocks.filter((b) => b.type === 'section').map((b) => (b as any).text.text).join(' ');
    expect(allText).toContain('preview.passcraft.com');
    expect(allText).toContain('feature/dashboard-filters');
  });

  it('should mention deployer via Slack ID', () => {
    const blocks = buildPreviewReadyMessage(previewData);
    const allText = blocks.filter((b) => b.type === 'section').map((b) => (b as any).text.text).join(' ');
    expect(allText).toContain('<@U_NABIL>');
  });

  it('should show issue references', () => {
    const blocks = buildPreviewReadyMessage(previewData);
    const allText = blocks.filter((b) => b.type === 'section').map((b) => (b as any).text.text).join(' ');
    expect(allText).toContain('#52');
    expect(allText).toContain('#53');
  });

  it('should include test checklist', () => {
    const blocks = buildPreviewReadyMessage(previewData);
    const allText = blocks.filter((b) => b.type === 'section').map((b) => (b as any).text.text).join(' ');
    expect(allText).toContain('Please test');
  });

  it('should include action buttons', () => {
    const blocks = buildPreviewReadyMessage(previewData);
    const actionsBlock = blocks.find((b) => b.type === 'actions');
    expect(actionsBlock).toBeDefined();
    if (actionsBlock && actionsBlock.type === 'actions') {
      expect(actionsBlock.elements).toHaveLength(2);
    }
  });

  it('should fall back to username when no Slack ID', () => {
    const noSlackData: PreviewReadyMessageData = { ...previewData, deployedBySlackId: null };
    const blocks = buildPreviewReadyMessage(noSlackData);
    const allText = blocks.filter((b) => b.type === 'section').map((b) => (b as any).text.text).join(' ');
    expect(allText).toContain('NabilW1995');
  });
});

describe('buildProductionDeployedMessage', () => {
  const deployData: ProductionDeployedMessageData = {
    repoName: 'PassCraft',
    productionUrl: 'passcraft.com',
    deployedBy: 'NabilW1995',
    deployedBySlackId: 'U_NABIL',
    issueNumbers: [52, 53],
    duration: '2h 34min',
  };

  it('should include Live text', () => {
    const blocks = buildProductionDeployedMessage(deployData);
    if (blocks[0].type === 'section') {
      expect(blocks[0].text.text).toContain('Live');
      expect(blocks[0].text.text).toContain('passcraft.com');
    }
  });

  it('should show issue numbers', () => {
    const blocks = buildProductionDeployedMessage(deployData);
    if (blocks[0].type === 'section') {
      expect(blocks[0].text.text).toContain('#52');
    }
  });

  it('should show duration', () => {
    const blocks = buildProductionDeployedMessage(deployData);
    const ctx = blocks.find((b) => b.type === 'context');
    expect(ctx).toBeDefined();
    if (ctx && ctx.type === 'context') {
      expect(ctx.elements[0].text).toContain('2h 34min');
    }
  });

  it('should work without duration', () => {
    const nd: ProductionDeployedMessageData = { ...deployData, duration: null };
    expect(buildProductionDeployedMessage(nd).length).toBeGreaterThan(0);
  });

  it('should work without issue numbers', () => {
    const ni: ProductionDeployedMessageData = { ...deployData, issueNumbers: [] };
    if (buildProductionDeployedMessage(ni)[0].type === 'section') {
      expect((buildProductionDeployedMessage(ni)[0] as any).text.text).not.toContain('#52');
    }
  });
});

describe('buildDeployFailedMessage', () => {
  const failData: DeployFailedMessageData = {
    repoName: 'PassCraft',
    branch: 'feature/broken-build',
    deployedBy: 'NabilW1995',
    deployedBySlackId: 'U_NABIL',
    errorMessage: 'Module not found',
  };

  it('should include Deploy Failed text', () => {
    if (buildDeployFailedMessage(failData)[0].type === 'section') {
      expect((buildDeployFailedMessage(failData)[0] as any).text.text).toContain('Deploy Failed');
    }
  });

  it('should show repo and branch', () => {
    const allText = buildDeployFailedMessage(failData).filter((b) => b.type === 'section').map((b) => (b as any).text.text).join(' ');
    expect(allText).toContain('PassCraft');
    expect(allText).toContain('feature/broken-build');
  });

  it('should show error message', () => {
    const allText = buildDeployFailedMessage(failData).filter((b) => b.type === 'section').map((b) => (b as any).text.text).join(' ');
    expect(allText).toContain('Module not found');
  });

  it('should mention deployer', () => {
    const allText = buildDeployFailedMessage(failData).filter((b) => b.type === 'section').map((b) => (b as any).text.text).join(' ');
    expect(allText).toContain('<@U_NABIL>');
  });

  it('should reassure customers are not affected', () => {
    const allText = buildDeployFailedMessage(failData).filter((b) => b.type === 'section').map((b) => (b as any).text.text).join(' ');
    expect(allText).toContain('customers are not affected');
  });

  it('should work without error message', () => {
    const ne: DeployFailedMessageData = { ...failData, errorMessage: null };
    expect(buildDeployFailedMessage(ne).length).toBeGreaterThan(0);
  });
});
