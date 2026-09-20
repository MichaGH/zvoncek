
read agents.md, read all the related files. implement wave 3 feature

wave-3-task-proposal-final

This is implementation by claude. I immidiatelly found some misstakes

1) when i click get help from manager or whatever, it opens

Ask manager

name

What do you need? Cena, navrh, iné

Then there is note - THIS NOTE, PLEASE MARK IT, LATER, WILL BE DIFFERENT. NOW ITS SHOWING THE COMPANY NOTE I TINK, THIS WILL LATER BE NOTE JUST FOR THIS REQUEST !!!!!!!!!! THSI CHANGES THE LEAD NOTE, THERE SHOULD BE NOTE FOR MANAGER WHEN FILLING THIS REQUEST, FULFILLING

I can choose manager - good. Here, we need to do something, I dont think choose manager from none. every salesrep will have manager assigned - put it there, and just make posibility to change it if they want. but b y default, lockedm ihcal. I would even do it that its just written there, click change, it alllows the dropdown

The UI/UX experience here is not very nice.

The way, when nothing selected, we can see multiple buttons down, then when I select they disappear and only some keep. 

the design is not very nice, not right spacing, play with the UI there, please, make it nice, professional

Also, very important - we have certain combinations

"send navrh"
"send cena"
"send email about us"
"send cennik"

Also wit this next step, its not correctly implemented. just so you understand

SALESREP calls, and they ask for CENA

salesrep clicks called, chooses CENA. Now, this next step automatically is "SEND CENA" you know.

if he asks the manager, the next step should still be "SEND CENA", even during the manager hold. Then when manger back its, the next step is SEND CENA. if you understand.

Therefore, why are we choosing next step there? And its very buggy, now , suddenly, when Im asking manager second time, I only see next step "send cena" "send navrh"

so, it shouldnt be this complicated. if the initial next step is "send cena", we make manager request so we can SEND cena, therefore this should be next step autuomatically. In case of INE, one can setup next step or keep the one that is there. But dont overcomplicate it!

It should not be very complicated, this is suppsoed to be convinient for work.
