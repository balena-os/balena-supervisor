/*
 * This class is a wrapper around the database setting and
 * receiving of target state. Because the target state can
 * only be set from a single place, but several workflows
 * rely on getting the target state at one point or another,
 * we cache the values using this class. Accessing the
 * database is inherently expensive, and for example the
 * local log backend accesses the target state for every log
 * line. This can very quickly cause serious memory problems
 * and database connection timeouts.
 */

export class ApplicationTargetState {}

export default ApplicationTargetState;
