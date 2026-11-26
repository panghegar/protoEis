const jakartaDay=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Jakarta',day:'2-digit'});

// UTC cron has no portable "last day of month" field. Trigger at 17:00 UTC
// on days 28–31, then only perform cleanup when the Jakarta calendar says day 1.
// Allow the whole first day so delayed invocations/retries are still valid.
export function isFirstDayInJakarta(date=new Date()){
 return jakartaDay.format(date)==='01';
}
