import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import {
  acknowledgeInput,
  ASSIGNMENT_STATUSES,
  assignInput,
  type AssignInput,
  calibrateInput,
  checkinInput,
  type CheckinInput,
  completeInput,
  courseInput,
  type CourseInput,
  cycleInput,
  type CycleInput,
  excludeInput,
  feedbackRequestInput,
  feedbackWriteInput,
  GOAL_STATUSES,
  goalInput,
  type GoalInput,
  goalStatusInput,
  hideInput,
  pathInput,
  type PathInput,
  recognitionInput,
  reviewWriteInput,
  type ReviewWriteInput,
  surveyAnswerInput,
  surveyInput,
  type SurveyInput,
  valueInput,
} from '@crew/contracts';
import { z } from 'zod';
import { RequireFeature, RequirePermission } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { EngagementService } from './engagement.service';
import { GoalsService } from './goals.service';
import { LearningService } from './learning.service';
import { ReviewsService } from './reviews.service';

const goalQuery = z.object({ view: z.enum(['mine', 'team']).default('mine'), employeeId: z.uuid().optional(), status: z.enum(GOAL_STATUSES).optional() });
const alignQuery = z.object({ employeeId: z.uuid().optional() });
const reviewQuery = z.object({ view: z.enum(['mine', 'team', 'feedback']).default('mine') });
const reviewerInput = z.object({ managerEmployeeId: z.uuid().nullable() });
const colleagueQuery = z.object({ q: z.string().trim().max(80).default('') });
const archivedQuery = z.object({ includeArchived: z.enum(['true', 'false']).optional() });
const assignmentQuery = z.object({
  view: z.enum(['mine', 'team']).default('mine'),
  status: z.enum([...ASSIGNMENT_STATUSES, 'overdue']).optional(),
  courseId: z.uuid().optional(),
});
const reasonInput = z.object({ reason: z.string().trim().min(3).max(500) });
const feedQuery = z.object({ employeeId: z.uuid().optional(), before: z.iso.datetime({ offset: true }).optional() });

@Controller('goals')
@RequireFeature('talent')
export class GoalsController {
  constructor(private readonly goals: GoalsService) {}

  @Get()
  @RequirePermission('performance:read')
  @Doc({ summary: "Goals: the caller's own (with weighted progress), one person's, or their team's", query: goalQuery })
  list(@Query(new ZodPipe(goalQuery)) q: z.infer<typeof goalQuery>) {
    return this.goals.list(q);
  }

  @Get('alignable')
  @RequirePermission('performance:read')
  @Doc({ summary: "Active goals a new goal can support (the owner's and their managers')", query: alignQuery })
  alignable(@Query(new ZodPipe(alignQuery)) q: z.infer<typeof alignQuery>) {
    return this.goals.alignable(q.employeeId);
  }

  @Get(':id')
  @RequirePermission('performance:read')
  @Doc({ summary: 'A goal with key results, check-ins and the goals it supports or is supported by' })
  get(@Param('id', UuidPipe) id: string) {
    return this.goals.get(id);
  }

  @Post()
  @RequirePermission('performance:read')
  @Doc({ summary: 'Set a goal for yourself, or for someone you manage', body: goalInput })
  create(@Body(new ZodPipe(goalInput)) body: GoalInput) {
    return this.goals.create(body);
  }

  @Put(':id')
  @RequirePermission('performance:read')
  @Doc({ summary: 'Change an active goal and its key results', body: goalInput })
  update(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(goalInput)) body: GoalInput) {
    return this.goals.update(id, body);
  }

  @Post(':id/checkins')
  @RequirePermission('performance:read')
  @Doc({ summary: 'Record progress: new key result values (or overall progress) and confidence', body: checkinInput })
  checkin(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(checkinInput)) body: CheckinInput) {
    return this.goals.checkin(id, body);
  }

  @Post(':id/status')
  @RequirePermission('performance:read')
  @Doc({ summary: 'Complete, cancel or reopen a goal', body: goalStatusInput })
  status(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(goalStatusInput)) body: z.infer<typeof goalStatusInput>) {
    return this.goals.setStatus(id, body.status, body.note);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('performance:read')
  @Doc({ summary: 'Delete a goal that has no check-ins and supports nothing' })
  remove(@Param('id', UuidPipe) id: string) {
    return this.goals.remove(id);
  }
}

@Controller()
@RequireFeature('talent')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  // Cycles (HR) --------------------------------------------------------------------------------------------------

  @Get('review-cycles')
  @RequirePermission('performance:configure')
  @Doc({ summary: 'Review cycles with progress' })
  cycles() {
    return this.reviews.listCycles();
  }

  @Get('review-cycles/:id')
  @RequirePermission('performance:configure')
  @Doc({ summary: 'A review cycle: every review, rating distributions, and (for a draft) who it would include' })
  cycle(@Param('id', UuidPipe) id: string) {
    return this.reviews.getCycle(id);
  }

  @Post('review-cycles')
  @RequirePermission('performance:configure')
  @Doc({ summary: 'Create a draft review cycle', body: cycleInput })
  createCycle(@Body(new ZodPipe(cycleInput)) body: CycleInput) {
    return this.reviews.createCycle(body);
  }

  @Put('review-cycles/:id')
  @RequirePermission('performance:configure')
  @Doc({ summary: 'Change a draft review cycle', body: cycleInput })
  updateCycle(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(cycleInput)) body: CycleInput) {
    return this.reviews.updateCycle(id, body);
  }

  @Delete('review-cycles/:id')
  @HttpCode(204)
  @RequirePermission('performance:configure')
  @Doc({ summary: 'Delete a draft review cycle' })
  removeCycle(@Param('id', UuidPipe) id: string) {
    return this.reviews.removeCycle(id);
  }

  @Post('review-cycles/:id/launch')
  @RequirePermission('performance:configure')
  @Doc({ summary: 'Launch a cycle: creates a review for everyone it includes and notifies them and their managers' })
  launch(@Param('id', UuidPipe) id: string) {
    return this.reviews.launch(id);
  }

  @Post('review-cycles/:id/calibration')
  @RequirePermission('performance:configure')
  @Doc({ summary: 'Close writing and start calibration (every manager review must be in)' })
  calibration(@Param('id', UuidPipe) id: string) {
    return this.reviews.startCalibration(id);
  }

  @Post('review-cycles/:id/release')
  @RequirePermission('performance:configure')
  @Doc({ summary: 'Release results to employees. Released reviews cannot change.' })
  release(@Param('id', UuidPipe) id: string) {
    return this.reviews.release(id);
  }

  // Reviews ------------------------------------------------------------------------------------------------------

  @Get('reviews')
  @RequirePermission('performance:read')
  @Doc({ summary: "The caller's reviews, the reviews they write as a manager, or feedback requested from them", query: reviewQuery })
  list(@Query(new ZodPipe(reviewQuery)) q: z.infer<typeof reviewQuery>) {
    return this.reviews.list(q.view);
  }

  @Get('reviews/:id')
  @RequirePermission('performance:read')
  @Doc({ summary: 'A review, showing only what the caller may see at this stage' })
  get(@Param('id', UuidPipe) id: string) {
    return this.reviews.get(id);
  }

  @Put('reviews/:id/self')
  @RequirePermission('performance:read')
  @Doc({ summary: 'Save or submit your self review', body: reviewWriteInput })
  writeSelf(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(reviewWriteInput)) body: ReviewWriteInput) {
    return this.reviews.writeSelf(id, body);
  }

  @Put('reviews/:id/manager')
  @RequirePermission('performance:read')
  @Doc({ summary: 'Save or submit the manager review (the reviewing manager only)', body: reviewWriteInput })
  writeManager(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(reviewWriteInput)) body: ReviewWriteInput) {
    return this.reviews.writeManager(id, body);
  }

  @Post('reviews/:id/feedback-requests')
  @RequirePermission('performance:read')
  @Doc({ summary: 'Ask colleagues for 360 feedback', body: feedbackRequestInput })
  requestFeedback(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(feedbackRequestInput)) body: z.infer<typeof feedbackRequestInput>) {
    return this.reviews.requestFeedback(id, body.reviewerEmployeeIds);
  }

  @Delete('reviews/:id/feedback-requests/:feedbackId')
  @HttpCode(204)
  @RequirePermission('performance:read')
  @Doc({ summary: 'Withdraw a feedback request that has not been answered' })
  withdrawFeedback(@Param('id', UuidPipe) id: string, @Param('feedbackId', UuidPipe) feedbackId: string) {
    return this.reviews.withdrawFeedback(id, feedbackId);
  }

  @Post('reviews/:id/calibrate')
  @RequirePermission('performance:configure')
  @Doc({ summary: 'Change the final rating during calibration, with a reason', body: calibrateInput })
  calibrate(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(calibrateInput)) body: z.infer<typeof calibrateInput>) {
    return this.reviews.calibrate(id, body.finalRating, body.reason);
  }

  @Post('reviews/:id/exclude')
  @RequirePermission('performance:configure')
  @Doc({ summary: 'Leave someone out of a cycle, with a reason (for example a long leave)', body: excludeInput })
  exclude(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(excludeInput)) body: z.infer<typeof excludeInput>) {
    return this.reviews.exclude(id, body.reason);
  }

  @Put('reviews/:id/reviewer')
  @RequirePermission('performance:configure')
  @Doc({ summary: 'Change who writes the manager review', body: reviewerInput })
  reviewer(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(reviewerInput)) body: z.infer<typeof reviewerInput>) {
    return this.reviews.reassignManager(id, body.managerEmployeeId);
  }

  @Post('reviews/:id/acknowledge')
  @RequirePermission('performance:read')
  @Doc({ summary: 'Acknowledge your released review, with an optional comment', body: acknowledgeInput })
  acknowledge(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(acknowledgeInput)) body: z.infer<typeof acknowledgeInput>) {
    return this.reviews.acknowledge(id, body.comment);
  }

  @Get('feedback/:id')
  @RequirePermission('performance:read')
  @Doc({ summary: 'A feedback request addressed to the caller' })
  feedback(@Param('id', UuidPipe) id: string) {
    return this.reviews.getFeedback(id);
  }

  @Put('feedback/:id')
  @RequirePermission('performance:read')
  @Doc({ summary: 'Save or submit feedback on a colleague', body: feedbackWriteInput })
  writeFeedback(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(feedbackWriteInput)) body: z.infer<typeof feedbackWriteInput>) {
    return this.reviews.writeFeedback(id, body.answers, body.submit);
  }

  @Post('feedback/:id/decline')
  @RequirePermission('performance:read')
  @Doc({ summary: 'Decline a feedback request' })
  declineFeedback(@Param('id', UuidPipe) id: string) {
    return this.reviews.declineFeedback(id);
  }

  @Get('talent/colleagues')
  @RequirePermission('performance:read')
  @Doc({ summary: 'Find current colleagues by name (name and department only), to ask for feedback or recognise them', query: colleagueQuery })
  colleagues(@Query(new ZodPipe(colleagueQuery)) q: z.infer<typeof colleagueQuery>) {
    return this.reviews.colleagues(q.q);
  }
}

@Controller('learning')
@RequireFeature('talent')
export class LearningController {
  constructor(private readonly learning: LearningService) {}

  @Get('courses')
  @RequirePermission('learning:read')
  @Doc({ summary: "The course catalogue, with the caller's own status for each course", query: archivedQuery })
  courses(@Query(new ZodPipe(archivedQuery)) q: z.infer<typeof archivedQuery>) {
    return this.learning.courses(q.includeArchived === 'true');
  }

  @Post('courses')
  @RequirePermission('learning:configure')
  @Doc({ summary: 'Add a course to the catalogue', body: courseInput })
  createCourse(@Body(new ZodPipe(courseInput)) body: CourseInput) {
    return this.learning.createCourse(body);
  }

  @Put('courses/:id')
  @RequirePermission('learning:configure')
  @Doc({ summary: 'Change a course', body: courseInput })
  updateCourse(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(courseInput)) body: CourseInput) {
    return this.learning.updateCourse(id, body);
  }

  @Delete('courses/:id')
  @HttpCode(204)
  @RequirePermission('learning:configure')
  @Doc({ summary: 'Archive a course (existing records are kept)' })
  archiveCourse(@Param('id', UuidPipe) id: string) {
    return this.learning.archiveCourse(id);
  }

  @Post('courses/:id/enrol')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Enrol yourself in a course open for self-enrolment' })
  enrol(@Param('id', UuidPipe) id: string) {
    return this.learning.enrol(id);
  }

  @Get('paths')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Learning paths and their courses' })
  paths() {
    return this.learning.paths();
  }

  @Post('paths')
  @RequirePermission('learning:configure')
  @Doc({ summary: 'Create a learning path', body: pathInput })
  createPath(@Body(new ZodPipe(pathInput)) body: PathInput) {
    return this.learning.createPath(body);
  }

  @Put('paths/:id')
  @RequirePermission('learning:configure')
  @Doc({ summary: 'Change a learning path', body: pathInput })
  updatePath(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(pathInput)) body: PathInput) {
    return this.learning.updatePath(id, body);
  }

  @Delete('paths/:id')
  @HttpCode(204)
  @RequirePermission('learning:configure')
  @Doc({ summary: 'Archive a learning path' })
  archivePath(@Param('id', UuidPipe) id: string) {
    return this.learning.archivePath(id);
  }

  @Get('assignments')
  @RequirePermission('learning:read')
  @Doc({ summary: "The caller's learning, or their team's (with overdue and expired flags)", query: assignmentQuery })
  assignments(@Query(new ZodPipe(assignmentQuery)) q: z.infer<typeof assignmentQuery>) {
    return this.learning.assignments(q);
  }

  @Post('assignments')
  @RequirePermission('learning:manage')
  @Doc({ summary: 'Assign a course or learning path to people in your scope', body: assignInput })
  assign(@Body(new ZodPipe(assignInput)) body: AssignInput) {
    return this.learning.assign(body);
  }

  @Post('assignments/:id/start')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Start an assigned course' })
  start(@Param('id', UuidPipe) id: string) {
    return this.learning.start(id);
  }

  @Post('assignments/:id/complete')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Record completion (classroom courses are confirmed by a manager or HR)', body: completeInput })
  complete(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(completeInput)) body: z.infer<typeof completeInput>) {
    return this.learning.complete(id, body.note, body.completedOn);
  }

  @Post('assignments/:id/cancel')
  @RequirePermission('learning:read')
  @Doc({ summary: 'Remove an assignment that is not complete', body: reasonInput })
  cancel(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(reasonInput)) body: z.infer<typeof reasonInput>) {
    return this.learning.cancel(id, body.reason);
  }
}

@Controller()
@RequireFeature('talent')
export class EngagementController {
  constructor(private readonly engagement: EngagementService) {}

  @Get('surveys')
  @RequirePermission('engagement:manage')
  @Doc({ summary: 'Surveys with invitation and response counts' })
  surveys() {
    return this.engagement.listSurveys();
  }

  @Get('surveys/:id')
  @RequirePermission('engagement:manage')
  @Doc({ summary: 'A survey and its questions' })
  survey(@Param('id', UuidPipe) id: string) {
    return this.engagement.getSurvey(id);
  }

  @Post('surveys')
  @RequirePermission('engagement:manage')
  @Doc({ summary: 'Create a draft anonymous survey', body: surveyInput })
  createSurvey(@Body(new ZodPipe(surveyInput)) body: SurveyInput) {
    return this.engagement.createSurvey(body);
  }

  @Put('surveys/:id')
  @RequirePermission('engagement:manage')
  @Doc({ summary: 'Change a draft survey', body: surveyInput })
  updateSurvey(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(surveyInput)) body: SurveyInput) {
    return this.engagement.updateSurvey(id, body);
  }

  @Delete('surveys/:id')
  @HttpCode(204)
  @RequirePermission('engagement:manage')
  @Doc({ summary: 'Delete a draft survey' })
  removeSurvey(@Param('id', UuidPipe) id: string) {
    return this.engagement.removeSurvey(id);
  }

  @Post('surveys/:id/open')
  @RequirePermission('engagement:manage')
  @Doc({ summary: 'Open a survey: invites its audience (which must be at least the anonymity threshold)' })
  open(@Param('id', UuidPipe) id: string) {
    return this.engagement.openSurvey(id);
  }

  @Post('surveys/:id/close')
  @RequirePermission('engagement:manage')
  @Doc({ summary: 'Close a survey' })
  close(@Param('id', UuidPipe) id: string) {
    return this.engagement.closeSurvey(id);
  }

  @Get('surveys/:id/results')
  @RequirePermission('engagement:manage')
  @Doc({ summary: 'Anonymous results, withheld below the threshold; small groups are merged or withheld' })
  results(@Param('id', UuidPipe) id: string) {
    return this.engagement.results(id);
  }

  @Get('my-surveys')
  @RequirePermission('surveys:respond')
  @Doc({ summary: 'Surveys the caller is invited to' })
  mySurveys() {
    return this.engagement.mySurveys();
  }

  @Get('my-surveys/:id')
  @RequirePermission('surveys:respond')
  @Doc({ summary: 'The questions of a survey the caller is invited to' })
  form(@Param('id', UuidPipe) id: string) {
    return this.engagement.form(id);
  }

  @Post('my-surveys/:id/responses')
  @RequirePermission('surveys:respond')
  @Doc({ summary: 'Answer a survey once. The answer is stored without your name.', body: surveyAnswerInput })
  respond(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(surveyAnswerInput)) body: z.infer<typeof surveyAnswerInput>) {
    return this.engagement.respond(id, body.answers);
  }

  @Get('recognition')
  @RequirePermission('recognition:give')
  @Doc({ summary: 'The recognition wall, newest first (50 at a time)', query: feedQuery })
  feed(@Query(new ZodPipe(feedQuery)) q: z.infer<typeof feedQuery>) {
    return this.engagement.feed(q);
  }

  @Post('recognition')
  @RequirePermission('recognition:give')
  @Doc({ summary: 'Recognise a colleague', body: recognitionInput })
  give(@Body(new ZodPipe(recognitionInput)) body: z.infer<typeof recognitionInput>) {
    return this.engagement.give(body);
  }

  @Post('recognition/:id/hide')
  @RequirePermission('engagement:manage')
  @Doc({ summary: 'Hide a recognition from the wall, with a reason', body: hideInput })
  hide(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(hideInput)) body: z.infer<typeof hideInput>) {
    return this.engagement.hide(id, body.reason);
  }

  @Get('company-values')
  @RequirePermission('recognition:give')
  @Doc({ summary: 'Company values used to tag recognition', query: archivedQuery })
  values(@Query(new ZodPipe(archivedQuery)) q: z.infer<typeof archivedQuery>) {
    return this.engagement.values(q.includeArchived === 'true');
  }

  @Post('company-values')
  @RequirePermission('engagement:manage')
  @Doc({ summary: 'Add a company value', body: valueInput })
  createValue(@Body(new ZodPipe(valueInput)) body: z.infer<typeof valueInput>) {
    return this.engagement.createValue(body);
  }

  @Put('company-values/:id')
  @RequirePermission('engagement:manage')
  @Doc({ summary: 'Change a company value', body: valueInput })
  updateValue(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(valueInput)) body: z.infer<typeof valueInput>) {
    return this.engagement.updateValue(id, body);
  }

  @Delete('company-values/:id')
  @HttpCode(204)
  @RequirePermission('engagement:manage')
  @Doc({ summary: 'Archive a company value' })
  archiveValue(@Param('id', UuidPipe) id: string) {
    return this.engagement.archiveValue(id);
  }
}
