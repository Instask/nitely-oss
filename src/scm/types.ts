export interface PublishChangeRequest {
  repoPath: string;
  worktreePath: string;
  remoteName: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
  bodyPath?: string;
}

export interface ChangeRequest {
  provider: "github";
  url: string;
  number: number;
  owner: string;
  repository: string;
  baseBranch: string;
  headBranch: string;
  draft: boolean;
  outcome?: "created" | "reused" | "updated";
}

export interface ChangeRequestTarget {
  provider: "github";
  owner: string;
  repository: string;
  number: number;
  url: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  headRepository: {
    owner: string;
    repository: string;
  };
  isCrossRepository: boolean;
}

export type PullRequestDiscussionKind =
  | "issue-comment"
  | "review-comment"
  | "review";

export interface PullRequestDiscussionItem {
  provider: "github";
  kind: PullRequestDiscussionKind;
  id: string;
  url: string;
  body: string;
  authorLogin: string;
  authorAssociation?: string;
  createdAt: string;
  updatedAt?: string;
  path?: string;
  line?: number;
  inReplyToId?: string;
}

export interface ListPullRequestDiscussionRequest {
  repoPath: string;
  remoteName: string;
  target: ChangeRequestTarget;
}

export interface CreatePullRequestCommentRequest {
  repoPath: string;
  remoteName: string;
  target: ChangeRequestTarget;
  body: string;
}

export interface ResolveChangeRequestTargetRequest {
  repoPath: string;
  remoteName: string;
  target: string;
}

export interface CheckoutChangeRequestRequest {
  repoPath: string;
  worktreePath: string;
  remoteName: string;
  target: ChangeRequestTarget;
}

export interface CheckoutChangeRequestResult {
  previousHeadSha: string;
}

export interface UpdateChangeRequestRequest {
  repoPath: string;
  worktreePath: string;
  remoteName: string;
  target: ChangeRequestTarget;
  title: string;
}

export interface UpdateChangeRequestResult {
  url: string;
  number: number;
  changeRequest: ChangeRequest;
  previousHeadSha: string;
  updatedHeadSha: string;
}

export interface ScmProvider {
  readonly type: string;
  publishChange(input: PublishChangeRequest): Promise<ChangeRequest>;
  resolveChangeRequestTarget?(
    input: ResolveChangeRequestTargetRequest,
  ): Promise<ChangeRequestTarget>;
  checkoutChangeRequest?(
    input: CheckoutChangeRequestRequest,
  ): Promise<CheckoutChangeRequestResult>;
  updateChangeRequest?(
    input: UpdateChangeRequestRequest,
  ): Promise<UpdateChangeRequestResult>;
  listPullRequestDiscussion?(
    input: ListPullRequestDiscussionRequest,
  ): Promise<PullRequestDiscussionItem[]>;
  createPullRequestComment?(
    input: CreatePullRequestCommentRequest,
  ): Promise<PullRequestDiscussionItem>;
}
