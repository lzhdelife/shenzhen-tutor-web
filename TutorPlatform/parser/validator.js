'use strict';

function validateStructuredOrder(order) {
  const issues = [];
  const current = new Set(order.subjectsCurrent?.value || []);
  const possible = new Set(order.subjectsPossible?.value || []);
  for (const subject of possible) {
    if (current.has(subject)) {
      current.delete(subject);
      issues.push({ code: 'possible_subject_removed_from_current', field: 'subjectsCurrent' });
    }
  }
  if (order.priceUnit?.value === '次' && order.price?.source === 'derived-hourly') {
    issues.push({ code: 'session_price_must_not_be_relabelled_hourly', field: 'priceUnit' });
  }
  if (order.studentGender?.value && order.teacherGender?.value && order.studentGender.rawEvidence === order.teacherGender.rawEvidence) {
    order.teacherGender = { value: '', rawEvidence: '', confidence: 0, source: 'rule' };
    issues.push({ code: 'student_teacher_gender_evidence_collision', field: 'teacherGender' });
  }
  if ((order.schedulePhases || []).length > 1 && order.schedulePhases.some(phase => !phase.phase)) {
    issues.push({ code: 'schedule_phase_missing_label', field: 'schedulePhases' });
  }
  return { order: { ...order, subjectsCurrent: { ...order.subjectsCurrent, value: [...current] } }, issues };
}

module.exports = { validateStructuredOrder };
