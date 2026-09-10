/* Shared quiz component.
 *
 * Markup contract — no per-lesson JavaScript required:
 *
 *   <div class="quiz" data-quiz>
 *     <p class="q">Question?</p>
 *     <button class="opt" data-correct>Right answer</button>
 *     <button class="opt">Wrong answer</button>
 *     <div class="why">Why the right answer is right.</div>
 *   </div>
 *
 * Feedback is immediate and automatic, which is the point: retrieval practice
 * only builds storage strength when the answer arrives while you still care.
 */
(function () {
  function wire(quiz) {
    var opts = quiz.querySelectorAll('.opt');
    var why = quiz.querySelector('.why');

    opts.forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (quiz.dataset.answered) return;
        quiz.dataset.answered = '1';

        opts.forEach(function (o) {
          o.disabled = true;
          if (o.hasAttribute('data-correct')) o.classList.add('right');
        });
        if (!btn.hasAttribute('data-correct')) btn.classList.add('wrong');
        if (why) why.classList.add('show');

        tally();
      });
    });
  }

  function tally() {
    var all = document.querySelectorAll('[data-quiz]');
    var done = 0;
    var right = 0;
    all.forEach(function (q) {
      if (!q.dataset.answered) return;
      done++;
      if (q.querySelector('.opt.wrong') === null) right++;
    });
    var out = document.querySelector('[data-score]');
    if (!out) return;
    out.textContent = done === all.length
      ? right + ' of ' + all.length + ' first time'
      : done + ' of ' + all.length + ' answered';
  }

  document.querySelectorAll('[data-quiz]').forEach(wire);
})();
