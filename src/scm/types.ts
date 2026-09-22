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

export interface ScmRepository {
  provider: "github";
  owner: string;
  repository: string;
  url: string;
}

export interface RepositoryIssue {
  provider: "github";
  owner: string;
  repository: string;
  number: number;
  url: string;
  title: string;
  body: string;
  state: "open" | "closed";
}

export interface RepositoryIssueComment {
  provider: "github";
  id: string;
  url: string;
  body: string;
  authorLogin: string;
  createdAt: string;
  updatedAt?: string;
}

export interface ResolveRepositoryRequest {
  repoPath: string;
  remoteName: string;
}

export interface ListRepositoryIssuesRequest extends ResolveRepositoryRequest {
  repository: ScmRepository;
}

export interface CreateRepositoryIssueRequest extends ResolveRepositoryRequest {
  repository: ScmRepository;
  title: string;
  body: string;
}

export interface ListRepositoryIssueCommentsRequest
  extends ResolveRepositoryRequest {
  repository: ScmRepository;
  issueNumber: number;
}

export interface CreateRepositoryIssueCommentRequest
  extends ListRepositoryIssueCommentsRequest {
  body: string;
}

export interface UpdateRepositoryIssueCommentRequest
  extends ResolveRepositoryRequest {
  repository: ScmRepository;
  commentId: string;
  body: string;
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
  metadataUpdate?: ChangeRequestMetadataUpdate;
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

export interface ChangeRequestStatus {
  provider: "github" | "unknown";
  url?: string;
  state: string;
  merged: boolean;
}

export interface GetChangeRequestStatusRequest {
  target: string;
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
  body?: string;
}

export interface ChangeRequestMetadataUpdate {
  transport: "github-rest-api" | "github-cli";
  outcome: "updated";
  fields: string[];
}

export interface UpdateChangeRequestResult {
  url: string;
  number: number;
  changeRequest: ChangeRequest;
  previousHeadSha: string;
  updatedHeadSha: string;
  metadataUpdate?: ChangeRequestMetadataUpdate;
}

export interface UpdateChangeRequestMetadataRequest {
  repoPath: string;
  worktreePath: string;
  remoteName: string;
  changeRequest: ChangeRequest;
  title?: string;
  body?: string;
  bodyPath?: string;
}

export interface UpdateChangeRequestMetadataResult {
  url: string;
  number: number;
  changeRequest: ChangeRequest;
  metadataUpdate: ChangeRequestMetadataUpdate;
}

export interface ScmProvider {
  readonly type: string;
  publishChange(input: PublishChangeRequest): Promise<ChangeRequest>;
  resolveRepository?(input: ResolveRepositoryRequest): Promise<ScmRepository>;
  listRepositoryIssues?(
    input: ListRepositoryIssuesRequest,
  ): Promise<RepositoryIssue[]>;
  createRepositoryIssue?(
    input: CreateRepositoryIssueRequest,
  ): Promise<RepositoryIssue>;
  listRepositoryIssueComments?(
    input: ListRepositoryIssueCommentsRequest,
  ): Promise<RepositoryIssueComment[]>;
  createRepositoryIssueComment?(
    input: CreateRepositoryIssueCommentRequest,
  ): Promise<RepositoryIssueComment>;
  updateRepositoryIssueComment?(
    input: UpdateRepositoryIssueCommentRequest,
  ): Promise<RepositoryIssueComment>;
  getChangeRequestStatus?(
    input: GetChangeRequestStatusRequest,
  ): Promise<ChangeRequestStatus>;
  resolveChangeRequestTarget?(
    input: ResolveChangeRequestTargetRequest,
  ): Promise<ChangeRequestTarget>;
  checkoutChangeRequest?(
    input: CheckoutChangeRequestRequest,
  ): Promise<CheckoutChangeRequestResult>;
  updateChangeRequest?(
    input: UpdateChangeRequestRequest,
  ): Promise<UpdateChangeRequestResult>;
  updateChangeRequestMetadata?(
    input: UpdateChangeRequestMetadataRequest,
  ): Promise<UpdateChangeRequestMetadataResult>;
  listPullRequestDiscussion?(
    input: ListPullRequestDiscussionRequest,
  ): Promise<PullRequestDiscussionItem[]>;
  createPullRequestComment?(
    input: CreatePullRequestCommentRequest,
  ): Promise<PullRequestDiscussionItem>;
}
